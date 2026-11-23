import { join } from 'node:path';
import {
  BrowserWindow,
  ipcMain,
  nativeImage,
  screen,
  type IpcMainInvokeEvent,
  type NativeImage,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import type { NativeControlFrame } from '../../computer/main/native-protocol';
import type {
  ControlEvent,
  ControlWindowButton,
  ControlWindowSnapshot,
} from '../../computer/shared/computer';
import type { Language } from '../../i18n/shared/language';
import type { Bounds, ForegroundControl, TargetRef } from '../../sessions/shared/automation';
import {
  CONTROL_SIZE,
  controlChannels,
  looks,
  marked,
  REVISION_BITS,
} from '../shared/control-window';

const READY_MS = 2_500;
const revision = z.int().positive();
const buttons = z
  .array(
    z.strictObject({
      command: z.enum(['stop', 'hand-back']),
      label: z.string().min(1).max(80),
      enabled: z.boolean(),
      bounds: z.strictObject({
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
    }),
  )
  .min(1)
  .max(2);

interface Ports {
  // The window the control is about: the helper's own handle of it, and where it last was.
  window(control: ForegroundControl): { id: string; bounds: Bounds } | undefined;
  name(owner: string): string;
  language(): Language;
  stop(owner: string): Promise<boolean>;
  handBack(owner: string, target: TargetRef): boolean;
  draw(revision: number, frame: NativeControlFrame | null): boolean;
}

// A dedicated hidden page draws the control. The helper displays its picture in a non-activating
// native panel, which it keeps above the window the control is about, and reports clicks with the
// revision that supplied their places.
export class ForegroundControlWindow {
  private panel?: BrowserWindow;
  private current?: ForegroundControl;
  private snapshot: ControlWindowSnapshot = { revision: 0, control: null };
  private paint?: PromiseWithResolvers<boolean>;
  private displayed = 0;
  // The density the hidden page draws at, the display's, so that the helper's panel shows the
  // control as sharply as the windows around it.
  private scale = 1;
  private windowId = '';
  private capturing = 0;
  private disposed = false;

  constructor(
    private readonly page: string,
    private readonly ports: Ports,
  ) {
    ipcMain.handle(controlChannels.snapshot, (event) => {
      this.caller(event);
      return this.snapshot;
    });
    ipcMain.handle(controlChannels.ready, async (event, value: unknown, layout: unknown) => {
      const panel = this.caller(event);
      const drawn = revision.parse(value);
      const control = this.snapshot.control;
      if (drawn !== this.snapshot.revision || !control || drawn <= this.capturing) return;
      const entries = buttons.parse(layout);
      if (
        entries.some(
          ({ bounds: { x, y, width, height } }) =>
            x < 0 || y < 0 || x + width > CONTROL_SIZE.width || y + height > CONTROL_SIZE.height,
        )
      )
        return;
      this.capturing = drawn;
      try {
        // The helper shows its last picture until it has another, so this goes on while the revision
        // is the current one.
        let capture: NativeImage | undefined;
        while (!capture && drawn === this.snapshot.revision && this.panel === panel)
          capture = await renderFrame(panel.webContents, drawn, this.scale);
        if (drawn !== this.snapshot.revision || this.panel !== panel || !capture) return;
        const frame = frameOf(capture, entries, this.scale);
        if (!frame || !this.ports.draw(drawn, { ...frame, window: this.windowId })) return;
        this.displayed = drawn;
        this.paint?.resolve(true);
      } finally {
        if (this.capturing === drawn && this.displayed !== drawn) this.capturing = drawn - 1;
      }
    });
  }

  owns(contents: WebContents): boolean {
    return this.panel?.webContents === contents;
  }

  async command(drawn: number, action: ControlEvent): Promise<boolean> {
    const control = this.current;
    if (!control) return false;
    // A press that comes while the control changes its state still means the one in control.
    if (action === 'shortcut') return this.ports.stop(control.sessionId);
    if (drawn !== this.snapshot.revision || drawn !== this.displayed) return false;
    if (action === 'stop') return this.ports.stop(control.sessionId);
    return (
      control.state === 'paused' &&
      control.pauseReason === 'user-input' &&
      this.ports.handBack(control.sessionId, control.target)
    );
  }

  update(control: ForegroundControl | undefined): void {
    if (this.disposed) return;
    const sameOperation = this.current?.operationId === control?.operationId;
    this.current = control;
    if (!control) {
      this.publish(null);
      return;
    }
    const window = this.ports.window(control);
    if (!window) {
      this.publish(null);
      return;
    }
    const shown = sameOperation && this.snapshot.control !== null;
    const scale = shown
      ? this.scale
      : densityOf(screen.getDisplayMatching(window.bounds).scaleFactor);
    const opened = this.panel === undefined;
    const panel = this.panel ?? this.open(scale);
    if (!shown) {
      if (!opened && scale !== this.scale) panel.webContents.setZoomFactor(scale);
      const { width, height } = pageSize(scale);
      panel.setContentSize(width, height);
    }
    this.scale = scale;
    this.windowId = window.id;
    this.publish({
      state:
        control.state === 'paused'
          ? control.pauseReason === 'secure-input'
            ? 'secure-input'
            : 'user'
          : control.state,
      session: this.ports.name(control.sessionId),
      application: control.application.name,
      stopShortcut: control.stopShortcut,
      language: this.ports.language(),
    });
  }

  refresh(): void {
    if (this.current) this.update(this.current);
  }

  async surface(
    owner: string,
    target: TargetRef,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const control = this.current;
    const panel = this.panel;
    const paint = this.paint;
    if (
      signal.aborted ||
      control?.state !== 'acting' ||
      owner !== control.sessionId ||
      target.id !== control.target.id ||
      target.generation !== control.target.generation ||
      !panel ||
      !paint
    )
      return;

    const deadline = AbortSignal.any([signal, AbortSignal.timeout(READY_MS)]);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const cancel = () => {
      resolve(false);
    };
    if (deadline.aborted) return;
    deadline.addEventListener('abort', cancel, { once: true });
    let shown: boolean;
    try {
      shown = await Promise.race([paint.promise, promise]);
    } finally {
      deadline.removeEventListener('abort', cancel);
    }
    if (shown && this.paint === paint && this.panel === panel) return this.displayed;
  }

  dispose(): void {
    this.disposed = true;
    this.current = undefined;
    this.publish(null);
    this.panel?.destroy();
    ipcMain.removeHandler(controlChannels.snapshot);
    ipcMain.removeHandler(controlChannels.ready);
  }

  private publish(control: ControlWindowSnapshot['control']): void {
    this.paint?.resolve(false);
    this.paint = control ? Promise.withResolvers<boolean>() : undefined;
    this.snapshot = { revision: this.snapshot.revision + 1, control };
    if (!control) this.ports.draw(this.snapshot.revision, null);
    this.panel?.webContents.send(controlChannels.state, this.snapshot);
  }

  private caller(event: IpcMainInvokeEvent): BrowserWindow {
    const panel = this.panel;
    const frame = event.senderFrame;
    if (
      event.sender !== panel?.webContents ||
      !frame ||
      frame !== event.sender.mainFrame ||
      frame.parent !== null ||
      frame.url !== this.page
    )
      throw Error('The control window answers only its own page.');
    return panel;
  }

  // The hidden page lays the control out at its size in points, and paints it at the display's
  // density: its window is that many times larger and zoomed as much.
  private open(scale: number): BrowserWindow {
    const panel = new BrowserWindow({
      ...pageSize(scale),
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/control-window.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true,
        zoomFactor: scale,
        focusOnNavigation: false,
        devTools: false,
      },
    });
    this.panel = panel;
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    const lost = () => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.publish(null);
      if (!panel.isDestroyed()) panel.destroy();
      if (!this.disposed && this.current) void this.ports.stop(this.current.sessionId);
    };
    panel.on('closed', lost);
    panel.webContents.on('render-process-gone', lost);
    void panel.loadURL(this.page).catch(lost);
    return panel;
  }
}

// The page in pixels, with the control drawn once for each of its looks.
function pageSize(scale: number): { width: number; height: number } {
  return {
    width: Math.round(CONTROL_SIZE.width * scale),
    height: Math.round(CONTROL_SIZE.height * scale) * looks.length,
  };
}

// The control's picture, and those of its buttons, cut on whole pixels so that each lies exactly over
// its place in the control.
function frameOf(
  page: NativeImage,
  buttons: readonly ControlWindowButton[],
  scale: number,
): Omit<NativeControlFrame, 'window'> | undefined {
  const { width, height } = pageSize(scale);
  const row = height / looks.length;
  const cut = (look: number, part: Bounds) =>
    page.crop({ ...part, y: look * row + part.y }).toPNG();
  const image = cut(0, { x: 0, y: 0, width, height: row });
  if (image.byteLength > 384 * 1024) return undefined;
  return {
    image: image.toString('base64'),
    size: CONTROL_SIZE,
    buttons: buttons.map((button) => {
      const x = Math.floor(button.bounds.x * scale);
      const y = Math.floor(button.bounds.y * scale);
      const right = Math.min(width, Math.ceil((button.bounds.x + button.bounds.width) * scale));
      const bottom = Math.min(row, Math.ceil((button.bounds.y + button.bounds.height) * scale));
      const part = { x, y, width: right - x, height: bottom - y };
      return {
        ...button,
        bounds: {
          x: x / scale,
          y: y / scale,
          width: part.width / scale,
          height: part.height / scale,
        },
        ...(button.enabled && {
          hover: cut(looks.indexOf('hover'), part).toString('base64'),
          pressed: cut(looks.indexOf('pressed'), part).toString('base64'),
        }),
      };
    }),
  };
}

// The page's picture at a revision, or none where it has not painted that in a second. A paint can
// still show the page as it was before.
function renderFrame(
  contents: WebContents,
  revision: number,
  scale: number,
): Promise<NativeImage | undefined> {
  return new Promise((resolve) => {
    let again: ReturnType<typeof setTimeout> | undefined;
    const finish = (frame?: NativeImage) => {
      clearTimeout(timer);
      clearTimeout(again);
      contents.removeListener('paint', paint);
      resolve(frame);
    };
    const paint = (_event: unknown, _bounds: Bounds, image: NativeImage) => {
      const frame = pictureOf(image, revision, scale);
      if (frame) {
        finish(frame);
        return;
      }
      clearTimeout(again);
      again = setTimeout(() => {
        contents.invalidate();
      }, 16);
    };
    const timer = setTimeout(finish, 1_000);
    timer.unref();
    contents.on('paint', paint);
    contents.invalidate();
  });
}

// A paint without its mark, or nothing where the mark is not the revision's.
function pictureOf(image: NativeImage, revision: number, scale: number): NativeImage | undefined {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) return undefined;
  const row = Math.floor(scale / 2) * width;
  for (let cell = 0; cell <= REVISION_BITS; cell++) {
    const alpha = bitmap[(row + Math.floor((cell + 0.5) * scale)) * 4 + 3] ?? 0;
    if (alpha > 127 !== marked(revision, cell)) return undefined;
  }
  const cells = Math.ceil((REVISION_BITS + 1) * scale) * 4;
  for (let y = 0; y < Math.ceil(scale); y++) bitmap.fill(0, y * width * 4, y * width * 4 + cells);
  return nativeImage.createFromBitmap(bitmap, { width, height });
}

// A display's density, as the helper takes it: whole or fractional, from one to three times.
function densityOf(scaleFactor: number | undefined): number {
  return Math.min(3, Math.max(1, scaleFactor ?? 1));
}
