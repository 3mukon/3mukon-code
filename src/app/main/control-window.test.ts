import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeControlFrame } from '../../computer/main/native-protocol';
import type { ControlWindowSnapshot } from '../../computer/shared/computer';
import type { ForegroundControl } from '../../sessions/shared/automation';
import { controlChannels, marked, REVISION_BITS } from '../shared/control-window';
import { ForegroundControlWindow } from './control-window';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  opened: vi.fn(),
  taken: vi.fn(),
  // The window the control is about, and whether the helper knows it.
  known: true,
  windowId: '9f1c0f5e-3d0b-4d9a-9a52-3f3f9b8d7c11',
  target: { x: 1300, y: 40, width: 600, height: 480 },
  // How many of the page's next paints show it as it was before, and whether it paints at all.
  stale: 0,
  paints: true,
  display: { scaleFactor: 1 },
}));

// A paint of the page at a revision: the control's pixels, under the mark along its top edge.
function picture(revision: number, { width, height }: { width: number; height: number }) {
  const scale = width / 560;
  const bitmap = Buffer.alloc(width * height * 4, 0x80);
  bitmap.fill(0, 0, scale * width * 4);
  for (let y = 0; y < scale; y++)
    for (let x = 0; x < (REVISION_BITS + 1) * scale; x++)
      if (marked(revision, Math.floor(x / scale))) bitmap[(y * width + x) * 4 + 3] = 255;
  return { getSize: () => ({ width, height }), toBitmap: () => bitmap };
}

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class TestWindow extends EventEmitter {
    private dead = false;
    private size = { width: 0, height: 0 };
    private revision = 0;
    readonly webContents = Object.assign(new EventEmitter(), {
      mainFrame: { parent: null, url: '' },
      send: vi.fn((_channel: string, snapshot: ControlWindowSnapshot) => {
        this.revision = snapshot.revision;
      }),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
      invalidate: vi.fn(() => {
        if (!fixture.paints) return;
        const shown = fixture.stale-- > 0 ? this.revision - 1 : this.revision;
        this.webContents.emit('paint', {}, {}, picture(shown, this.size));
      }),
    });
    constructor(options: unknown) {
      super();
      fixture.opened(this, options);
    }
    loadURL(page: string): Promise<void> {
      this.webContents.mainFrame.url = page;
      return Promise.resolve();
    }
    setContentSize = vi.fn((width: number, height: number) => {
      this.size = { width, height };
    });
    isDestroyed(): boolean {
      return this.dead;
    }
    destroy(): void {
      this.dead = true;
      this.emit('closed');
    }
  }
  return {
    BrowserWindow: TestWindow,
    nativeImage: {
      createFromBitmap: (bitmap: Buffer, size: unknown) => {
        fixture.taken(bitmap, size);
        return {
          crop: (part: Record<'x' | 'y' | 'width' | 'height', number>) => ({
            toPNG: () =>
              Buffer.from(
                `${String(part.x)},${String(part.y)} ${String(part.width)}×${String(part.height)}`,
              ),
          }),
        };
      },
    },
    screen: { getDisplayMatching: () => fixture.display },
    ipcMain: {
      handle: (name: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        fixture.handlers.set(name, fn);
      },
      removeHandler: (name: string) => {
        fixture.handlers.delete(name);
      },
    },
  };
});

const target = { id: 'window', generation: 3, kind: 'window' } as const;
const acting: ForegroundControl = {
  sessionId: 'fixture-session',
  application: {
    ref: { id: 'app', generation: 2, kind: 'application' },
    owner: 'fixture-session',
    name: 'Fixture',
  },
  target,
  operationId: 'operation',
  stopShortcut: true,
  state: 'acting',
};
const page = 'file:///synthetic/control-window.html';
const stop = vi.fn(() => Promise.resolve(true));
const handBack = vi.fn(() => true);
const draw = vi.fn<(revision: number, frame: NativeControlFrame | null) => boolean>(() => true);
const stopButton = {
  command: 'stop',
  label: 'Stop',
  bounds: { x: 200, y: 4, width: 40, height: 30 },
  enabled: true,
};
const cut = (part: string) => Buffer.from(part).toString('base64');
let host: ForegroundControlWindow;

beforeEach(() => {
  fixture.opened.mockReset();
  fixture.taken.mockReset();
  fixture.stale = 0;
  fixture.paints = true;
  fixture.display.scaleFactor = 1;
  fixture.known = true;
  stop.mockClear();
  handBack.mockClear();
  draw.mockClear();
  host = new ForegroundControlWindow(page, {
    window: () =>
      fixture.known ? { id: fixture.windowId, bounds: { ...fixture.target } } : undefined,
    name: () => 'Fixture session',
    language: () => 'en',
    stop,
    handBack,
    draw,
  });
});
afterEach(() => {
  host.dispose();
});

function invoke(channel: string, event: unknown, ...args: unknown[]) {
  const answer = fixture.handlers.get(channel);
  if (!answer) throw Error('Missing fixture handler.');
  return answer(event, ...args);
}

function controlPage() {
  const window = fixture.opened.mock.calls[0]?.[0] as {
    webContents: { mainFrame: { parent: null; url: string } };
  };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const read = () => invoke(controlChannels.snapshot, event) as ControlWindowSnapshot;
  return { event, read };
}

it('shows only after the owned page draws, over the window it names, and lets a takeover be handed back', async () => {
  host.update(acting);
  const { event, read } = controlPage();
  expect(fixture.opened.mock.calls[0]?.[1]).toMatchObject({
    focusable: false,
    show: false,
  });
  const surface = host.surface(acting.sessionId, target, new AbortController().signal);
  const first = read();
  expect(draw).not.toHaveBeenCalled();
  await invoke(controlChannels.ready, event, first.revision, [stopButton]);
  expect(draw).toHaveBeenLastCalledWith(
    first.revision,
    expect.objectContaining({
      image: cut('0,0 560×48'),
      window: fixture.windowId,
      size: { width: 560, height: 48 },
      buttons: [{ ...stopButton, hover: cut('200,52 40×30'), pressed: cut('200,100 40×30') }],
    }),
  );
  await expect(surface).resolves.toBe(first.revision);
  await expect(host.command(first.revision, 'hand-back')).resolves.toBe(false);

  host.update({ ...acting, state: 'paused', pauseReason: 'user-input' });
  await expect(host.command(first.revision, 'stop')).resolves.toBe(false);
  const second = read();
  await invoke(controlChannels.ready, event, second.revision, [stopButton]);
  await expect(host.command(second.revision, 'hand-back')).resolves.toBe(true);
  expect(handBack).toHaveBeenCalledExactlyOnceWith(acting.sessionId, target);
  await expect(host.command(second.revision, 'stop')).resolves.toBe(true);
  expect(stop).toHaveBeenCalledExactlyOnceWith(acting.sessionId);
  host.update(undefined);
  expect(draw).toHaveBeenLastCalledWith(second.revision + 1, null);
  await expect(host.command(second.revision, 'stop')).resolves.toBe(false);
});

it('stops whoever is in control at the shortcut, whichever picture shows', async () => {
  await expect(host.command(1, 'shortcut')).resolves.toBe(false);
  host.update(acting);
  await expect(host.command(1, 'shortcut')).resolves.toBe(true);
  host.update({ ...acting, state: 'paused', pauseReason: 'user-input' });
  await expect(host.command(1, 'shortcut')).resolves.toBe(true);
  expect(stop.mock.calls).toEqual([[acting.sessionId], [acting.sessionId]]);
  host.update(undefined);
  await expect(host.command(3, 'shortcut')).resolves.toBe(false);
});

it('rejects other frames and cancels an input waiting for the control renderer', async () => {
  host.update(acting);
  const { event, read } = controlPage();
  const current = read();
  const foreign = { ...event, senderFrame: { parent: null, url: page } };
  await expect(
    invoke(controlChannels.ready, foreign, current.revision, [stopButton]),
  ).rejects.toThrow('own page');
  const controller = new AbortController();
  const pending = host.surface(acting.sessionId, target, controller.signal);
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  expect(stop).not.toHaveBeenCalled();
});

it('draws the control at the display’s density, laid out at its size in points', async () => {
  fixture.display.scaleFactor = 2;
  host.update(acting);
  const window = fixture.opened.mock.calls[0]?.[0] as {
    setContentSize: ReturnType<typeof vi.fn>;
    webContents: { setZoomFactor: ReturnType<typeof vi.fn> };
  };
  expect(fixture.opened.mock.calls[0]?.[1]).toMatchObject({
    width: 1120,
    height: 288,
    webPreferences: { zoomFactor: 2 },
  });
  expect(window.setContentSize).toHaveBeenLastCalledWith(1120, 288);
  const { event, read } = controlPage();
  const first = read();
  // The page reports its buttons in points. The helper gets them on whole pixels, with their pictures.
  const bounds = { x: 200.3, y: 4.2, width: 40, height: 30 };
  const stopping = { ...stopButton, command: 'hand-back', label: 'Hand Back', enabled: false };
  await invoke(controlChannels.ready, event, first.revision, [{ ...stopButton, bounds }, stopping]);
  expect(draw).toHaveBeenLastCalledWith(
    first.revision,
    expect.objectContaining({
      image: cut('0,0 1120×96'),
      size: { width: 560, height: 48 },
      buttons: [
        {
          ...stopButton,
          bounds: { x: 200, y: 4, width: 40.5, height: 30.5 },
          hover: cut('400,104 81×61'),
          pressed: cut('400,200 81×61'),
        },
        stopping,
      ],
    }),
  );
  // Another operation on a display of standard density draws at its density.
  fixture.display.scaleFactor = 1;
  host.update({ ...acting, operationId: 'another' });
  expect(window.webContents.setZoomFactor).toHaveBeenLastCalledWith(1);
  expect(window.setContentSize).toHaveBeenLastCalledWith(560, 144);
});

it('takes no picture of the page as it was before, and takes its mark out of the one it takes', async () => {
  fixture.display.scaleFactor = 2;
  host.update(acting);
  const { event, read } = controlPage();
  await invoke(controlChannels.ready, event, read().revision, [stopButton]);
  draw.mockClear();
  fixture.taken.mockClear();

  fixture.stale = 2;
  host.update({ ...acting, state: 'paused', pauseReason: 'user-input' });
  const { revision } = read();
  await invoke(controlChannels.ready, event, revision, [stopButton]);
  expect(draw).toHaveBeenCalledExactlyOnceWith(revision, expect.anything());
  expect(fixture.stale).toBe(-1);

  const [bitmap, size] = fixture.taken.mock.calls[0] as [Buffer, unknown];
  expect(size).toEqual({ width: 1120, height: 288 });
  expect(bitmap.subarray(0, 2 * 1120 * 4).every((byte) => byte === 0)).toBe(true);
  expect(bitmap.subarray(2 * 1120 * 4).every((byte) => byte === 0x80)).toBe(true);
});

it('goes on until the page has painted its state, and no longer than that is the state', async () => {
  vi.useFakeTimers();
  try {
    host.update(acting);
    const { event, read } = controlPage();
    const first = read().revision;
    fixture.paints = false;
    const drawing = invoke(controlChannels.ready, event, first, [stopButton]);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(draw).not.toHaveBeenCalled();
    fixture.paints = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await drawing;
    expect(draw).toHaveBeenCalledExactlyOnceWith(first, expect.anything());

    fixture.paints = false;
    host.update({ ...acting, state: 'stopping' });
    const second = read().revision;
    const ending = invoke(controlChannels.ready, event, second, [stopButton]);
    await vi.advanceTimersByTimeAsync(1_500);
    host.update(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await ending;
    expect(draw.mock.calls.map(([revision, frame]) => [revision, frame === null])).toEqual([
      [first, false],
      [second + 1, true],
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it('draws nothing for a window the helper does not know', async () => {
  fixture.known = false;
  host.update(acting);
  expect(fixture.opened).not.toHaveBeenCalled();
  expect(draw).toHaveBeenLastCalledWith(1, null);
  await expect(
    host.surface(acting.sessionId, target, new AbortController().signal),
  ).resolves.toBeUndefined();
});
