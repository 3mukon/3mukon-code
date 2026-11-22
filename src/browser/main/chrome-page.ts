import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeImage } from 'electron';
import { z } from 'zod';
import type { Outcome } from '../../sessions/shared/automation';
import type { BrowserNavigation } from '../shared/browser';
import { actionOutcome, inPage, observation, viewport } from './dom-runner';
import {
  refused,
  webAddress,
  type BrowserPage,
  type PageAction,
  type PageCapture,
  type PageEvents,
  type PageObservation,
} from './page';

const frame = z.object({ id: z.string().min(1).max(128), url: z.string() });
const frameTree = z.object({ frameTree: z.object({ frame }) });
const world = z.object({ executionContextId: z.int().positive() });
const evaluation = z.object({ result: z.object({ value: z.unknown() }) });
const screenshot = z.object({ data: z.base64().max(1024 * 1024) });
const documentInfo = z.object({ title: z.string().max(256), address: z.string().max(4096) });
const target = z.object({
  targetInfo: z.object({ type: z.literal('page'), targetId: z.string().min(1).max(128) }),
});
const navigation = z.object({
  errorText: z.string().optional(),
  isDownload: z.boolean().optional(),
});
const okay = (): Outcome<null> => ({ status: 'verified', value: null });
const dispatched = (): Outcome<null> => ({ status: 'dispatched', evidence: 'not-verified' });
const lost = (): Outcome<null> => ({
  status: 'indeterminate',
  reason: 'backend-lost',
  exclusionHeld: false,
});

// The commands the app's extension accepts for its task tabs.
export type ChromeCommand =
  | 'Target.getTargetInfo'
  | 'Page.enable'
  | 'Page.getFrameTree'
  | 'Page.createIsolatedWorld'
  | 'Page.captureScreenshot'
  | 'Page.navigate'
  | 'Page.bringToFront'
  | 'Page.handleJavaScriptDialog'
  | 'Runtime.evaluate';

export interface ChromePageDriver {
  attach(): Promise<unknown>;
  detach(): Promise<unknown>;
  command(method: ChromeCommand, params?: object): Promise<unknown>;
  close(): void;
  onPageEvent?: (method: string, value: unknown) => void;
}

export class ChromePage implements BrowserPage {
  private readonly worldName = 'app-browser-' + randomUUID();
  private revision = 0;
  private closed = false;
  private refresh?: Promise<void>;
  private capturing?: Promise<PageCapture | null>;

  private constructor(
    private readonly driver: ChromePageDriver,
    private readonly events: PageEvents,
    private readonly activate: () => Promise<void>,
  ) {}

  // A task tab the extension opens for the page, blank until its first navigation.
  static async connect(
    driver: ChromePageDriver,
    events: PageEvents,
    activate: () => Promise<void>,
  ): Promise<ChromePage> {
    const page = new ChromePage(driver, events, activate);
    try {
      await driver.attach();
      target.parse(await driver.command('Target.getTargetInfo'));
      driver.onPageEvent = (method, value) => {
        page.pageEvent(method, value);
      };
      await driver.command('Page.enable');
      return page;
    } catch {
      driver.close();
      throw new Error('The Chrome task tab is unavailable.');
    }
  }

  async navigate(command: BrowserNavigation, signal: AbortSignal): Promise<Outcome<null>> {
    if (command.kind !== 'navigate' || !webAddress(command.url)) return refused('invalid-request');
    if (signal.aborted) return { status: 'cancelled-before-dispatch', effects: 'none' };
    if (this.closed) return refused('connection-lost');
    try {
      this.revision++;
      const response = navigation.parse(
        await this.driver.command('Page.navigate', { url: command.url }),
      );
      if (response.isDownload) return lost();
      if (!response.errorText) await this.updateDocument();
      return dispatched();
    } catch {
      return lost();
    }
  }

  async observe(marker: string): Promise<PageObservation> {
    await this.refresh;
    return observation.parse(await this.run({ kind: 'observe', marker }));
  }

  capture(signal?: AbortSignal): Promise<PageCapture | null> {
    if (signal?.aborted) return Promise.resolve(null);
    this.capturing ??= this.captureFrame(signal).finally(() => {
      this.capturing = undefined;
    });
    return this.capturing;
  }

  private async captureFrame(signal?: AbortSignal): Promise<PageCapture | null> {
    const unavailable = () => this.closed || signal?.aborted === true;
    try {
      await this.refresh;
      if (unavailable()) return null;
      const revision = this.revision;
      const box = viewport.parse(await this.run({ kind: 'viewport' }, signal));
      if (unavailable() || revision !== this.revision) return null;
      const { data } = screenshot.parse(
        await this.driver.command('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 60,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { ...box, scale: Math.min(1, 1600 / box.width, 1000 / box.height) },
        }),
      );
      if (unavailable() || revision !== this.revision) return null;
      const { width, height } = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize();
      if (!width || !height) return null;
      return {
        image: { data, mediaType: 'image/jpeg' },
        width,
        height,
        viewport: { width: box.width, height: box.height },
        capturedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async action(marker: string, action: PageAction): Promise<Outcome<null>> {
    if (this.closed) return refused('connection-lost');
    try {
      return actionOutcome.parse(
        await this.run({ kind: 'action', marker, action, outsideApp: true }),
      );
    } catch {
      return lost();
    }
  }

  async openExternal(): Promise<Outcome<null>> {
    if (this.closed) return refused('connection-lost');
    try {
      await this.context();
      await this.driver.command('Page.bringToFront');
      await this.activate();
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await this.evaluate("document.hasFocus() && document.visibilityState === 'visible'"))
          return okay();
        await delay(80);
      }
      return dispatched();
    } catch {
      return lost();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.driver.onPageEvent = undefined;
    try {
      await this.driver.detach();
    } catch {
      this.driver.close();
    }
  }

  private async context(signal?: AbortSignal): Promise<number> {
    if (this.closed) throw new Error('Chrome tab closed.');
    signal?.throwIfAborted();
    const { frameTree: tree } = frameTree.parse(await this.driver.command('Page.getFrameTree'));
    if (!webAddress(tree.frame.url)) throw new Error('Chrome page is unavailable.');
    signal?.throwIfAborted();
    const created = world.parse(
      await this.driver.command('Page.createIsolatedWorld', {
        frameId: tree.frame.id,
        worldName: this.worldName,
      }),
    );
    return created.executionContextId;
  }

  private async evaluate(expression: string, signal?: AbortSignal): Promise<unknown> {
    const contextId = await this.context(signal);
    if (this.closed) throw new Error('Chrome tab closed.');
    signal?.throwIfAborted();
    const response = await this.driver.command('Runtime.evaluate', {
      contextId,
      expression,
      returnByValue: true,
    });
    return evaluation.parse(response).result.value;
  }

  private run(input: Parameters<typeof inPage>[0], signal?: AbortSignal): Promise<unknown> {
    return this.evaluate('(' + inPage.toString() + ')(' + JSON.stringify(input) + ')', signal);
  }

  private pageEvent(method: string, value: unknown): void {
    if (method === 'app.tab-ended') {
      this.events.ended();
      return;
    }
    if (method === 'Page.javascriptDialogOpening') {
      const dialog = z.object({ type: z.enum(['alert', 'confirm', 'prompt']) }).safeParse(value);
      if (dialog.success) this.events.dialog(dialog.data.type);
      void this.driver.command('Page.handleJavaScriptDialog', { accept: false }).catch(() => {
        this.driver.close();
      });
      return;
    }
    if (method === 'app.active-popup') {
      this.events.popup?.();
      return;
    }
    if (method === 'Page.frameNavigated') {
      const top = z
        .object({ frame: frame.extend({ parentId: z.undefined().optional() }) })
        .safeParse(value);
      if (!top.success) return;
      if (top.data.frame.url === 'about:blank') return;
      if (!webAddress(top.data.frame.url)) {
        this.driver.close();
        return;
      }
    } else if (method !== 'Page.navigatedWithinDocument' && method !== 'Page.frameResized') {
      return;
    }
    void this.updateDocument(method === 'Page.frameResized' ? 'geometry' : 'document');
  }

  private updateDocument(generation: 'document' | 'geometry' = 'document'): Promise<void> {
    this.revision++;
    this.refresh = this.readDocument(generation).catch(() => undefined);
    return this.refresh;
  }

  private async readDocument(generation: 'document' | 'geometry' = 'document'): Promise<void> {
    const revision = this.revision;
    const { title, address } = documentInfo.parse(
      await this.evaluate('({ title: document.title.slice(0, 256), address: location.href })'),
    );
    if (this.closed || revision !== this.revision) return;
    this.events.change(
      {
        address,
        title: title || 'Chrome tab',
        loading: false,
        error: null,
        canGoBack: false,
        canGoForward: false,
        signIn: 'unknown',
      },
      generation,
    );
  }
}
