import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalBridge } from '../shared/terminal';
import { TerminalViews } from './terminal-views';

const emulator = vi.hoisted(() => ({
  write: vi.fn<(data: string, done?: () => void) => void>((_data, done) => done?.()),
  open: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    write = emulator.write;
    open = emulator.open;
    focus = emulator.focus;
    dispose = emulator.dispose;
    loadAddon = () => undefined;
    onData = () => undefined;
    onResize = () => undefined;
    attachCustomKeyEventHandler = () => undefined;
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = () => undefined;
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function connection() {
  const outputs = new Set<Parameters<TerminalBridge['onOutput']>[0]>();
  const exits = new Set<Parameters<TerminalBridge['onExit']>[0]>();
  const bridge: TerminalBridge = {
    open: () => Promise.resolve({ id: 't1', cwd: '/tmp', program: 'zsh' }),
    write: () => Promise.resolve(),
    resize: () => Promise.resolve(),
    onOutput: (listener) => {
      outputs.add(listener);
      return () => {
        outputs.delete(listener);
      };
    },
    onExit: (listener) => {
      exits.add(listener);
      return () => {
        exits.delete(listener);
      };
    },
    confirmClose: () => Promise.resolve(true),
    close: () => Promise.resolve(),
    openLink: () => Promise.resolve(),
  };
  return {
    bridge,
    outputs,
    exits,
    output: (data: string) => {
      for (const receive of outputs) receive('t1', data);
    },
  };
}

describe('TerminalViews', () => {
  it('passes early and live output once in order, retaining the emulator when subscriptions reconnect', () => {
    vi.useFakeTimers();
    const { bridge, outputs, exits, output } = connection();
    const views = new TerminalViews(bridge, (code) => `Exited ${String(code)}`);
    expect(outputs.size).toBe(0);
    const stop = views.connect();
    const chunks = Array.from({ length: 200 }, (_, index) => `chunk ${String(index)}\r\n`);
    for (const chunk of chunks) output(chunk);
    const host = document.createElement('div');
    document.body.append(host);
    const hide = views.show('t1', host);
    output('live');
    expect(emulator.write.mock.calls.map(([data]) => data)).toEqual([...chunks, 'live']);

    stop();
    expect([outputs.size, exits.size]).toEqual([0, 0]);
    const reconnect = views.connect();
    output('after reconnect');
    expect(emulator.write.mock.calls.map(([data]) => data)).toEqual([
      ...chunks,
      'live',
      'after reconnect',
    ]);
    expect(emulator.open).toHaveBeenCalledOnce();
    expect(emulator.dispose).not.toHaveBeenCalled();
    hide();
    views.dispose('t1');
    reconnect();
    expect(emulator.dispose).toHaveBeenCalledOnce();
    expect([outputs.size, exits.size]).toEqual([0, 0]);
  });
});
