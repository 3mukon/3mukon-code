import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeControlFrame } from '../../computer/main/native-protocol';
import type { ControlWindowSnapshot } from '../../computer/shared/computer';
import type { ForegroundControl } from '../../sessions/shared/automation';
import { controlChannels } from '../shared/control-window';
import { ForegroundControlWindow } from './control-window';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  opened: vi.fn(),
  display: { id: 2, scaleFactor: 1, workArea: { x: 1200, y: 24, width: 1000, height: 720 } },
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class TestWindow extends EventEmitter {
    private dead = false;
    readonly webContents = Object.assign(new EventEmitter(), {
      mainFrame: { parent: null, url: '' },
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
      invalidate: vi.fn(() => {
        this.webContents.emit(
          'paint',
          {},
          {},
          {
            toBitmap: () => Buffer.from([0, 0, 0, 255]),
            toPNG: () => Buffer.from('frame'),
          },
        );
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
    setContentSize = vi.fn();
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
let host: ForegroundControlWindow;

beforeEach(() => {
  fixture.opened.mockReset();
  fixture.display.workArea.x = 1200;
  fixture.display.scaleFactor = 1;
  stop.mockClear();
  handBack.mockClear();
  draw.mockClear();
  host = new ForegroundControlWindow(page, {
    bounds: () => ({ x: 1300, y: 40, width: 600, height: 480 }),
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

it('shows only after the owned page draws and preserves its frame across a takeover', async () => {
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
    expect.objectContaining({ bounds: first.control?.bounds, buttons: [stopButton] }),
  );
  await expect(surface).resolves.toBe(first.revision);
  await expect(host.command(first.revision, 'hand-back')).resolves.toBe(false);

  fixture.display.workArea.x = -1200;
  host.update({ ...acting, state: 'paused', pauseReason: 'user-input' });
  await expect(host.command(first.revision, 'stop')).resolves.toBe(false);
  const second = read();
  expect(second.control?.bounds).toEqual(first.control?.bounds);
  await invoke(controlChannels.ready, event, second.revision, [stopButton]);
  await expect(host.command(second.revision, 'hand-back')).resolves.toBe(true);
  expect(handBack).toHaveBeenCalledExactlyOnceWith(acting.sessionId, target);
  await expect(host.command(second.revision, 'stop')).resolves.toBe(true);
  expect(stop).toHaveBeenCalledExactlyOnceWith(acting.sessionId);
  host.update(undefined);
  expect(draw).toHaveBeenLastCalledWith(second.revision + 1, null);
  await expect(host.command(second.revision, 'stop')).resolves.toBe(false);
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
    height: 96,
    webPreferences: { zoomFactor: 2 },
  });
  expect(window.setContentSize).toHaveBeenLastCalledWith(1120, 96);
  const { event, read } = controlPage();
  const first = read();
  // The page reports its buttons in points, as the helper places them.
  expect(first.control?.bounds).toMatchObject({ width: 560, height: 48 });
  await invoke(controlChannels.ready, event, first.revision, [stopButton]);
  expect(draw).toHaveBeenLastCalledWith(
    first.revision,
    expect.objectContaining({ bounds: first.control?.bounds, buttons: [stopButton] }),
  );
  // Another operation on a display of standard density draws at its density.
  fixture.display.scaleFactor = 1;
  host.update({ ...acting, operationId: 'another' });
  expect(window.webContents.setZoomFactor).toHaveBeenLastCalledWith(1);
  expect(window.setContentSize).toHaveBeenLastCalledWith(560, 48);
});
