import {
  WebContentsView,
  session,
  type BrowserWindow,
  type Session,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import type { Outcome } from '../../sessions/shared/automation';
import type { BrowserLoadError, BrowserNavigation } from '../shared/browser';
import { actionOutcome, inPage, observation, viewport } from './dom-runner';
import { ElectronBrowserPanel } from './electron-panel';
import { FILE_DRAG_SCRIPT } from './file-drag';
import {
  type BrowserPage,
  type EmbeddedEngine,
  type PageAction,
  type PageCapture,
  type PageEvents,
  type PageObservation,
  refused,
  webAddress,
} from './page';

const WORLD = 1001;
const MAX_IMAGE_EDGE = 1600;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const LOAD_MS = 25_000;
const CONTAINMENT_MS = 5_000;
const DISMISS_BINDING = '__appEmbeddedDialogDismissed';
const DRAG_BINDING = '__appEmbeddedFileDrag';
const DRAG_WORLD = 'app-embedded-file-drag';
const dialogKind = z.enum(['alert', 'confirm', 'prompt']);
const bindingEvent = z.object({ name: z.literal(DISMISS_BINDING), payload: dialogKind });
const dragEvent = z.object({ name: z.literal(DRAG_BINDING), payload: z.literal('file') });
const childSession = z.object({ sessionId: z.string().min(1).max(128) });
const javascriptDialog = z.object({ type: z.string(), hasBrowserHandler: z.boolean() });
const fileChooser = z.object({ backendNodeId: z.int().positive() });
const okay = (): Outcome<null> => ({ status: 'verified', value: null });
const dispatched = (): Outcome<null> => ({ status: 'dispatched', evidence: 'not-verified' });

export class ElectronEmbeddedEngine implements EmbeddedEngine {
  private readonly configured = new WeakSet<Session>();
  private readonly temporary = new Map<string, Session>();

  async page(partition: string, events: PageEvents): Promise<BrowserPage> {
    const isolated = this.partition(partition);
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableDialogs: true,
        devTools: false,
        navigateOnDragDrop: false,
      },
    });
    view.setBounds({ x: 0, y: 0, width: 1040, height: 760 });
    view.setVisible(false);
    const page = new ElectronPage(view, events);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new Error('Embedded browser containment timed out.'));
        }, CONTAINMENT_MS);
      });
      await Promise.race([page.contain(), timeout]);
      return page;
    } catch {
      await page.close();
      throw new Error('Embedded browser containment could not be applied.');
    } finally {
      clearTimeout(deadline);
    }
  }

  async clear(partition: string): Promise<void> {
    const storage = partition.startsWith('persist:')
      ? this.partition(partition)
      : this.temporary.get(partition);
    if (!storage) return;
    await storage.closeAllConnections();
    await storage.clearStorageData();
    await storage.clearCache();
    await storage.clearAuthCache();
    storage.flushStorageData();
    this.temporary.delete(partition);
  }

  private partition(name: string): Session {
    const isolated = session.fromPartition(name);
    if (!name.startsWith('persist:')) this.temporary.set(name, isolated);
    if (!this.configured.has(isolated)) {
      this.configured.add(isolated);
      isolated.setPermissionCheckHandler(() => false);
      isolated.setPermissionRequestHandler((_contents, _permission, answer) => {
        answer(false);
      });
      isolated.setDevicePermissionHandler(() => false);
      isolated.setDisplayMediaRequestHandler((_request, answer) => {
        answer({});
      });
      isolated.on('will-download', (event) => {
        event.preventDefault();
      });
      isolated.webRequest.onBeforeRequest(({ url, resourceType }, answer) => {
        const navigation = resourceType === 'mainFrame' || resourceType === 'subFrame';
        answer({ cancel: navigation && !allowedNavigation(url) });
      });
    }
    return isolated;
  }
}

function allowedNavigation(url: string): boolean {
  return url === 'about:blank' || url === 'about:srcdoc' || webAddress(url) !== null;
}

// Prompt is normally unsupported in Electron. Return Cancel from the start of each document,
// keeping the engine's dialog ban as the containment boundary. These events are untrusted facts
// about a dismissal and carry no page text or request for an app action.
function dismissDialogs(binding: string) {
  const global = window as unknown as Record<string, unknown>;
  const report = global[binding] as ((kind: string) => void) | undefined;
  for (const kind of ['alert', 'confirm', 'prompt']) {
    Object.defineProperty(window, kind, {
      value: () => {
        report?.(kind);
        return kind === 'prompt' ? null : kind === 'confirm' ? false : undefined;
      },
      configurable: true,
      writable: true,
    });
  }
}

class ElectronPage implements BrowserPage {
  private readonly contents: WebContents;
  private bootstrapEntry = true;
  private error: BrowserLoadError | null = null;
  private closing = false;
  private readonly destroyed: Promise<void>;
  private dialogs = 0;
  private panel: ElectronBrowserPanel | undefined;
  private captureRevision = 0;
  private capturing: { revision: number; result: Promise<PageCapture | null> } | undefined;

  constructor(
    private readonly view: WebContentsView,
    private readonly events: PageEvents,
  ) {
    const c = view.webContents;
    this.contents = c;
    this.destroyed = new Promise((resolve) => {
      c.once('destroyed', resolve);
    });
    c.setAudioMuted(true);
    c.setWindowOpenHandler(() => ({ action: 'deny' }));
    c.on('will-frame-navigate', (event) => {
      if (!allowedNavigation(event.url)) {
        event.preventDefault();
      }
    });
    c.on('will-redirect', (event) => {
      if (!allowedNavigation(event.url)) {
        event.preventDefault();
      }
    });
    c.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
    c.on('select-bluetooth-device', (event, _devices, choose) => {
      event.preventDefault();
      choose('');
    });
    c.on('login', (event, _details, _authInfo, answer) => {
      event.preventDefault();
      answer();
    });
    c.on('did-start-navigation', (event) => {
      if (!event.isMainFrame) return;
      this.error = null;
      this.dialogs = 0;
      this.publish('document');
    });
    c.on('did-start-loading', () => {
      this.publish();
    });
    c.on('did-stop-loading', () => {
      this.publish();
    });
    c.on('did-navigate', () => {
      if (this.bootstrapEntry && webAddress(c.getURL())) {
        this.bootstrapEntry = false;
        const history = c.navigationHistory;
        if (history.getActiveIndex() > 0 && history.getEntryAtIndex(0).url === 'about:blank') {
          history.removeEntryAtIndex(0);
        }
      }
      this.publish();
    });
    c.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.publish('document');
    });
    c.on('page-title-updated', () => {
      this.publish();
    });
    c.on('did-fail-load', (_event, code, _description, _url, main) => {
      if (!main || code === -3) return; // A stopped or replaced navigation.
      this.error = loadError(code);
      this.publish();
    });
    c.on('render-process-gone', () => {
      this.ended();
    });
    c.once('destroyed', () => {
      this.ended();
    });
    c.debugger.on('detach', () => {
      this.ended();
    });
  }

  async contain(): Promise<void> {
    // Chromium can leave DevTools commands pending until a new view has navigated. Bootstrap a
    // local empty document so containment can be installed before any website loads.
    await this.contents.loadURL('about:blank');
    const debug = this.contents.debugger;
    debug.attach('1.3');
    const frameSessions = new Set<string>();
    debug.on('message', (_event, method, params: unknown, sessionId) => {
      if (method === 'Runtime.bindingCalled') {
        const event = bindingEvent.safeParse(params);
        if (event.success) this.dismissed(event.data.payload);
        if (dragEvent.safeParse(params).success) this.panel?.giveUpFileDrag();
      } else if (method === 'Target.attachedToTarget') {
        const session = childSession.safeParse(params);
        if (!session.success) {
          this.ended();
          return;
        }
        const id = session.data.sessionId;
        frameSessions.add(id);
        void this.protectFrame(id).catch(() => {
          if (frameSessions.has(id)) this.ended();
        });
      } else if (method === 'Target.detachedFromTarget') {
        const session = childSession.safeParse(params);
        if (session.success) frameSessions.delete(session.data.sessionId);
      } else if (method === 'Page.javascriptDialogOpening') {
        const event = javascriptDialog.safeParse(params);
        if (!event.success) {
          this.ended();
          return;
        }
        this.dismissed(event.data.type);
        if (event.data.hasBrowserHandler)
          void debug
            .sendCommand('Page.handleJavaScriptDialog', { accept: false }, sessionId)
            .catch(() => {
              this.ended();
            });
      } else if (method === 'Page.fileChooserOpened') {
        const event = fileChooser.safeParse(params);
        if (!event.success) return;
        void debug
          .sendCommand(
            'DOM.setFileInputFiles',
            { files: [], backendNodeId: event.data.backendNodeId },
            sessionId,
          )
          .catch(() => {
            this.ended();
          });
      }
    });
    await this.protectFrame();
  }

  private async protectFrame(sessionId?: string): Promise<void> {
    const debug = this.contents.debugger;
    await debug.sendCommand('Page.enable', {}, sessionId);
    await debug.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
    await debug.sendCommand('Runtime.enable', {}, sessionId);
    await debug.sendCommand('Runtime.addBinding', { name: DISMISS_BINDING }, sessionId);
    await debug.sendCommand(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: '(' + dismissDialogs.toString() + ')(' + JSON.stringify(DISMISS_BINDING) + ')',
        runImmediately: true,
      },
      sessionId,
    );
    await debug.sendCommand(
      'Runtime.addBinding',
      { name: DRAG_BINDING, executionContextName: DRAG_WORLD },
      sessionId,
    );
    await debug.sendCommand(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source:
          FILE_DRAG_SCRIPT + '(() => globalThis[' + JSON.stringify(DRAG_BINDING) + ']("file"))',
        worldName: DRAG_WORLD,
        runImmediately: true,
      },
      sessionId,
    );
    // An iframe in a separate renderer needs its own debugger session. Install the guards
    // before letting that renderer run any page code.
    await debug.sendCommand(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'iframe' }, { exclude: true }],
      },
      sessionId,
    );
    if (sessionId) await debug.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  async navigate(command: BrowserNavigation, signal: AbortSignal): Promise<Outcome<null>> {
    const c = this.contents;
    if (signal.aborted) return { status: 'cancelled-before-dispatch', effects: 'none' };
    if (command.kind === 'stop-loading') {
      c.stop();
      return okay();
    }
    const stopped = AbortSignal.any([signal, AbortSignal.timeout(LOAD_MS)]);
    const stop = () => {
      if (!c.isDestroyed()) c.stop();
    };
    this.error = null;
    this.dialogs = 0;
    stopped.addEventListener('abort', stop, { once: true });
    try {
      if (command.kind === 'navigate') {
        const url = webAddress(command.url);
        if (!url) return refused('invalid-request');
        await c.loadURL(url.href);
      } else {
        const history = c.navigationHistory;
        if (
          (command.kind === 'back' && !history.canGoBack()) ||
          (command.kind === 'forward' && !history.canGoForward())
        )
          return refused('not-found');
        const committed = await this.waitForLoad(stopped, () => {
          if (command.kind === 'back') history.goBack();
          else if (command.kind === 'forward') history.goForward();
          else c.reload();
        });
        if (!committed) return dispatched();
      }
      if (stopped.aborted) return dispatched();
      return this.loaded() ? okay() : dispatched();
    } catch {
      this.navigationFailed(signal, stopped.aborted ? 'timed-out' : 'unreachable');
      return dispatched();
    } finally {
      stopped.removeEventListener('abort', stop);
    }
  }

  async observe(marker: string): Promise<PageObservation> {
    this.dialogs = 0;
    return observation.parse(await this.evaluate({ kind: 'observe', marker }));
  }

  async action(marker: string, action: PageAction): Promise<Outcome<null>> {
    this.dialogs = 0;
    return actionOutcome.parse(await this.evaluate({ kind: 'action', marker, action }));
  }

  mount(window: BrowserWindow, focused: () => void, fileDragged: () => void): ElectronBrowserPanel {
    this.panel?.release();
    this.panel = new ElectronBrowserPanel(
      this.view,
      window,
      () => this.events.userInput(),
      focused,
      () => {
        this.publish('geometry');
      },
      fileDragged,
    );
    return this.panel;
  }

  capture(): Promise<PageCapture | null> {
    const revision = this.captureRevision;
    if (this.capturing) {
      return this.capturing.revision === revision ? this.capturing.result : Promise.resolve(null);
    }
    const result = this.captureViewport()
      .then((frame) => (this.captureRevision === revision && this.loaded() ? frame : null))
      .finally(() => {
        this.capturing = undefined;
      });
    this.capturing = { revision, result };
    return result;
  }

  private async captureViewport(): Promise<PageCapture | null> {
    const bounds = this.view.getBounds();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const before = viewport.parse(await this.evaluate({ kind: 'viewport' }));
    let image = await this.contents.capturePage(undefined, { stayHidden: true });
    const capturedAt = Date.now();
    const after = viewport.parse(await this.evaluate({ kind: 'viewport' }));
    if (
      Object.keys(before).some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
      )
    )
      return null;
    if (image.isEmpty()) return null;
    const original = image.getSize();
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(original.height, original.width));
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(original.width * scale)) });
    const size = image.getSize();
    const png = image.toPNG();
    const bytes = png.length <= MAX_IMAGE_BYTES ? png : image.toJPEG(80);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    return {
      ...size,
      viewport: { width: before.width, height: before.height },
      capturedAt,
      image: {
        data: bytes.toString('base64'),
        mediaType: bytes === png ? 'image/png' : 'image/jpeg',
      },
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.destroyed;
    this.closing = true;
    this.panel?.release();
    if (!this.contents.isDestroyed()) this.contents.close({ waitForBeforeUnload: false });
    return this.destroyed;
  }

  private ended(): void {
    if (this.closing) return;
    void this.close();
    this.events.ended();
  }

  private dismissed(value: unknown): void {
    const kind = dialogKind.safeParse(value);
    if (kind.success && this.dialogs++ < 32) this.events.dialog(kind.data);
  }

  private navigationFailed(signal: AbortSignal, error: BrowserLoadError): void {
    if (this.contents.isDestroyed() || signal.aborted || this.error) return;
    this.error = error;
    this.publish();
  }

  private loaded(): boolean {
    return (
      !this.contents.isDestroyed() && !this.error && webAddress(this.contents.getURL()) !== null
    );
  }

  private evaluate(input: Parameters<typeof inPage>[0]): Promise<unknown> {
    return this.contents.executeJavaScriptInIsolatedWorld(WORLD, [
      {
        code: '(' + inPage.toString() + ')(' + JSON.stringify(input) + ')',
      },
    ]);
  }

  private publish(change?: 'document' | 'geometry'): void {
    const c = this.contents;
    if (c.isDestroyed()) return;
    if (change) this.captureRevision++;
    this.events.change(
      {
        title: c.getTitle() || 'Browser tab',
        address: c.getURL() || null,
        loading: c.isLoadingMainFrame(),
        error: this.error,
        canGoBack: c.navigationHistory.canGoBack(),
        canGoForward: c.navigationHistory.canGoForward(),
        signIn: 'unknown',
      },
      change,
    );
  }

  private waitForLoad(signal: AbortSignal, navigate: () => void): Promise<boolean> {
    const c = this.contents;
    return new Promise((resolve, reject) => {
      let committed = false;
      const onNavigate = () => {
        committed = true;
      };
      const done = () => {
        c.off('did-navigate', onNavigate);
        c.off('did-stop-loading', done);
        c.off('did-navigate-in-page', inPageNavigation);
        c.off('destroyed', done);
        signal.removeEventListener('abort', done);
        resolve(committed);
      };
      const inPageNavigation = (_event: unknown, _url: string, main: boolean) => {
        if (!main) return;
        onNavigate();
        done();
      };
      c.on('did-navigate', onNavigate);
      c.once('did-stop-loading', done);
      c.on('did-navigate-in-page', inPageNavigation);
      c.once('destroyed', done);
      signal.addEventListener('abort', done, { once: true });
      try {
        navigate();
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Browser navigation failed.'));
        done();
      }
    });
  }
}

function loadError(code: number): BrowserLoadError {
  if (code <= -200 && code > -300) return 'certificate';
  if (code === -7 || code === -118) return 'timed-out';
  if ([-20, -22, -27, -30].includes(code)) return 'blocked';
  return 'unreachable';
}
