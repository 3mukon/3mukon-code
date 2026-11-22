import { join } from 'node:path';
import {
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
  type NativeImage,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import type { NativeControlFrame } from '../../computer/main/native-protocol';
import type { ControlCommand, ControlWindowSnapshot } from '../../computer/shared/computer';
import type { Language } from '../../i18n/shared/language';
import type { Bounds, ForegroundControl, TargetRef } from '../../sessions/shared/automation';
import { controlChannels } from '../shared/control-window';

const WIDTH = 560;
const HEIGHT = 48;
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
  bounds(control: ForegroundControl): Bounds | undefined;
  name(owner: string): string;
  language(): Language;
  stop(owner: string): Promise<boolean>;
  handBack(owner: string, target: TargetRef): boolean;
  draw(revision: number, frame: NativeControlFrame | null): boolean;
}

// A dedicated hidden page draws the control. The helper displays its frame in a non-activating
// native panel and reports clicks with the revision that supplied their control bounds.
export class ForegroundControlWindow {
  private panel?: BrowserWindow;
  private current?: ForegroundControl;
  private snapshot: ControlWindowSnapshot = { revision: 0, control: null };
  private paint?: PromiseWithResolvers<boolean>;
  private displayed = 0;
  // The density the hidden page draws at, the display's, so that the helper's panel shows the
  // control as sharply as the windows around it.
  private scale = 1;
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
      const { width, height } = control.bounds;
      if (
        entries.some(
          ({ bounds: { x, y, width: w, height: h } }) =>
            x < 0 || y < 0 || x + w > width || y + h > height,
        )
      )
        return;
      this.capturing = drawn;
      try {
        const capture = await renderFrame(panel.webContents);
        if (drawn !== this.snapshot.revision || this.panel !== panel || !capture) return;
        const png = capture.toPNG();
        if (png.byteLength > 384 * 1024) return;
        if (
          !this.ports.draw(drawn, {
            image: png.toString('base64'),
            bounds: control.bounds,
            buttons: entries,
          })
        )
          return;
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

  async command(drawn: number, action: ControlCommand): Promise<boolean> {
    const control = this.current;
    if (!control || drawn !== this.snapshot.revision || drawn !== this.displayed) return false;
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
    const target = this.ports.bounds(control);
    if (!target) {
      this.publish(null);
      return;
    }
    const currentPlacement = sameOperation ? this.snapshot.control : null;
    const display = screen.getDisplayMatching(target);
    const bounds = currentPlacement?.bounds ?? controlBounds(display.workArea);
    const scale = currentPlacement ? this.scale : densityOf(display.scaleFactor);
    const opened = this.panel === undefined;
    const panel = this.panel ?? this.open(bounds, scale);
    if (!currentPlacement) {
      if (!opened && scale !== this.scale) panel.webContents.setZoomFactor(scale);
      panel.setContentSize(Math.round(bounds.width * scale), Math.round(bounds.height * scale));
    }
    this.scale = scale;
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
      displayId: currentPlacement?.displayId ?? display.id,
      bounds,
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
  private open(bounds: Bounds, scale: number): BrowserWindow {
    const panel = new BrowserWindow({
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale),
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

function renderFrame(contents: WebContents): Promise<NativeImage | undefined> {
  return new Promise((resolve) => {
    const finish = (frame?: NativeImage) => {
      clearTimeout(timer);
      contents.removeListener('paint', paint);
      resolve(frame);
    };
    const paint = (_event: unknown, _bounds: Bounds, image: NativeImage) => {
      const bitmap = image.toBitmap();
      for (let offset = 3; offset < bitmap.length; offset += 4) {
        if (bitmap[offset] !== 0) {
          finish(image);
          return;
        }
      }
    };
    const timer = setTimeout(finish, 1_000);
    timer.unref();
    contents.on('paint', paint);
    contents.invalidate();
  });
}

// A display's density, as the helper takes it: whole or fractional, from one to three times.
function densityOf(scaleFactor: number | undefined): number {
  return Math.min(3, Math.max(1, scaleFactor ?? 1));
}

function controlBounds(area: Bounds): Bounds {
  const width = Math.min(WIDTH, area.width);
  const height = Math.min(HEIGHT, area.height);
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.min(14, area.height - height),
    width,
    height,
  };
}
