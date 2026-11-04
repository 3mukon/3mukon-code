import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminals, type Pty, type PtyOptions, type TerminalViewer } from './terminals';

// Pseudo-terminals the test drives: what started where, what was written and sized, and what is in
// the foreground.
function ptys() {
  const started: {
    file: string;
    args: string[];
    options: PtyOptions;
    pty: Pty & {
      foreground: string;
      written: string[];
      sizes: [number, number][];
      killed: boolean;
    };
    print: (data: string) => void;
    end: (code: number) => void;
  }[] = [];
  const spawn = (file: string, args: string[], options: PtyOptions) => {
    let print: (data: string) => void = () => undefined;
    let end: (code: number) => void = () => undefined;
    const pty = {
      foreground: file.split('/').at(-1) ?? '',
      written: [] as string[],
      sizes: [] as [number, number][],
      killed: false,
      get process() {
        return pty.foreground;
      },
      onData(listener: (data: string) => void) {
        print = listener;
      },
      onExit(listener: (code: number) => void) {
        end = listener;
      },
      write(data: string) {
        pty.written.push(data);
      },
      resize(columns: number, rows: number) {
        pty.sizes.push([columns, rows]);
      },
      kill() {
        pty.killed = true;
      },
    };
    started.push({
      file,
      args,
      options,
      pty,
      print: (data) => {
        print(data);
      },
      end: (code) => {
        end(code);
      },
    });
    return pty;
  };
  return { spawn, started };
}

// A window the terminals print to, with spies on what it hears.
function viewer(id: number) {
  const output = vi.fn<TerminalViewer['output']>();
  const exit = vi.fn<TerminalViewer['exit']>();
  const window: TerminalViewer = { id, output, exit };
  return Object.assign(window, { heard: output, ended: exit });
}

const options = { shell: '/bin/zsh', home: '/Users/me', env: { TERM: 'xterm-256color' } };

describe('Terminals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the login shell in a folder, or in the home folder, and a program in the home folder, each once its window gives its size', () => {
    vi.useFakeTimers();
    const { spawn, started } = ptys();
    const terminals = new Terminals(spawn, options);
    const window = viewer(1);
    const web = terminals.open(window, '/Users/me/web');
    expect(web).toMatchObject({ cwd: '/Users/me/web', program: 'zsh' });
    const home = terminals.open(window, null);
    expect(home.cwd).toBe('/Users/me');
    const login = terminals.open(window, '/Users/me/web', { file: '/app/codex', args: ['login'] });
    expect(login).toMatchObject({ cwd: '/Users/me', program: 'codex login' });
    expect(started).toHaveLength(0);
    terminals.resize(window, web.id, 120, 40);
    terminals.resize(window, login.id, 90, 30);
    // A terminal whose window gives no size in time starts at 80 by 24.
    vi.advanceTimersByTime(1_000);
    expect(
      started.map(({ file, args, options: { cwd, columns, rows } }) => [
        file,
        args,
        cwd,
        columns,
        rows,
      ]),
    ).toEqual([
      ['/bin/zsh', ['-l'], '/Users/me/web', 120, 40],
      ['/app/codex', ['login'], '/Users/me', 90, 30],
      ['/bin/zsh', ['-l'], '/Users/me', 80, 24],
    ]);
    expect(started[0]?.options.env).toEqual(options.env);
  });

  it('passes output and the exit to the window that opened the terminal, and its typing and size back', () => {
    const { spawn, started } = ptys();
    const terminals = new Terminals(spawn, options);
    const window = viewer(1);
    const other = viewer(2);
    const { id } = terminals.open(window, null);
    // What the user types before the program starts reaches it once it has.
    terminals.write(window, id, 'echo early\r');
    terminals.resize(window, id, 100, 30);
    const [shell] = started;
    shell?.print('$ ');
    expect(window.heard).toHaveBeenCalledWith(id, '$ ');
    terminals.write(window, id, 'ls\r');
    terminals.resize(window, id, 120.6, 0);
    expect(shell?.pty.written).toEqual(['echo early\r', 'ls\r']);
    expect(shell?.pty.sizes).toEqual([[120, 1]]);
    // Another window reaches none of it.
    expect(() => {
      terminals.write(other, id, 'rm -rf ~\r');
    }).toThrow('No such terminal');
    shell?.end(0);
    expect(window.ended).toHaveBeenCalledWith(id, 0);
    terminals.write(window, id, 'more\r');
    expect(shell?.pty.written).toEqual(['echo early\r', 'ls\r']);
    expect(other.heard).not.toHaveBeenCalled();
  });

  it('says what closing would end: a program the shell runs, or the program it started with until it ends', async () => {
    const { spawn, started } = ptys();
    const terminals = new Terminals(spawn, options);
    const window = viewer(1);
    const shell = terminals.open(window, null);
    expect(terminals.busy(window, shell.id)).toBeNull();
    terminals.resize(window, shell.id, 80, 24);
    expect(terminals.busy(window, shell.id)).toBeNull();
    const pty = started[0]?.pty;
    if (pty !== undefined) pty.foreground = 'vim';
    expect(terminals.busy(window, shell.id)).toBe('vim');
    const login = terminals.open(window, null, { file: '/app/grok', args: ['login'] });
    expect(terminals.busy(window, login.id)).toBe('grok login');
    terminals.resize(window, login.id, 80, 24);
    const ended = terminals.ended(login.id);
    started[1]?.end(1);
    expect(await ended).toBe(1);
    expect(terminals.busy(window, login.id)).toBeNull();
  });

  it('ends a terminal as it closes, as its window goes, and every one as the app quits', () => {
    vi.useFakeTimers();
    const { spawn, started } = ptys();
    const terminals = new Terminals(spawn, options);
    const first = viewer(1);
    const second = viewer(2);
    const one = terminals.open(first, null);
    const two = terminals.open(first, null);
    const three = terminals.open(second, null);
    for (const [window, id] of [
      [first, one.id],
      [first, two.id],
      [second, three.id],
    ] as const) {
      terminals.resize(window, id, 80, 24);
    }
    terminals.close(second, one.id);
    expect(started[0]?.pty.killed).toBe(false);
    terminals.close(first, one.id);
    expect(started[0]?.pty.killed).toBe(true);
    // What a closed terminal still prints goes nowhere.
    started[0]?.print('late');
    expect(first.heard).not.toHaveBeenCalled();
    terminals.closeViewer(1);
    expect(started.map(({ pty }) => pty.killed)).toEqual([true, true, false]);
    terminals.closeAll();
    expect(started.map(({ pty }) => pty.killed)).toEqual([true, true, true]);
    // One closed before it started never starts.
    terminals.close(first, terminals.open(first, null).id);
    vi.advanceTimersByTime(1_000);
    expect(started).toHaveLength(3);
  });
});
