import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { MAX_COLUMNS, MAX_ROWS, type TerminalInfo } from '../shared/terminal';

// A pseudo-terminal with a program running in it, as node-pty gives one (ADR-0015).
export interface Pty {
  // The name of the program in the terminal's foreground: the one it started with, or one that
  // program runs.
  readonly process: string;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
}

export interface PtyOptions {
  cwd: string;
  columns: number;
  rows: number;
  env: Record<string, string>;
}

// Starts a program in a new pseudo-terminal.
export type SpawnPty = (file: string, args: string[], options: PtyOptions) => Pty;

// A program a terminal starts with instead of the shell, such as a provider's sign-in command.
export interface Program {
  file: string;
  args: string[];
}

// The window a terminal prints to: the one that opened it.
export interface TerminalViewer {
  // The window's own id, by which the terminals it opened end with it.
  readonly id: number;
  output(id: string, data: string): void;
  exit(id: string, code: number): void;
}

export interface TerminalsOptions {
  // The user's login shell, which a terminal runs unless it starts with a program.
  shell: string;
  // The folder a terminal starts in when it is given none.
  home: string;
  // The environment the terminals' programs start with.
  env: Record<string, string>;
}

interface Running {
  info: TerminalInfo;
  // The program and where it starts, until it has started.
  start: { file: string; args: string[]; cwd: string };
  pty: Pty | null;
  // What the user typed before the program started, which it reads once it has.
  typed: string[];
  // Starts the program at the terminal's size until its panel gives one.
  fallback: ReturnType<typeof setTimeout>;
  viewer: TerminalViewer;
  // The terminal started with the shell, not a program of its own.
  shell: boolean;
  exited: boolean;
  // Resolves with the exit code once the program the terminal started with ends.
  ended: Promise<number>;
  end: (code: number) => void;
}

// A terminal's size should its panel give none in time, and that time.
const COLUMNS = 80;
const ROWS = 24;
const SIZE_WAIT_MS = 1_000;

// The terminals the main process runs for the windows. Each is a pseudo-terminal whose program prints
// to the window that opened it and reads what that window sends; the terminals pass both on without
// reading, keeping or logging them (ADR-0016). A terminal starts with the user's login shell in a
// folder, or with a program, such as a provider's sign-in command, in the home folder, once its panel
// has given its size, so that the program never draws for another width. It runs until it is closed,
// after its program has ended too, or until the window that opened it goes; quitting the app closes
// them all.
export class Terminals {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly spawn: SpawnPty,
    private readonly options: TerminalsOptions,
  ) {}

  // Opens a terminal for the window: the shell in the folder, or in the home folder when it is null,
  // or the program in the home folder. Its program starts at the first size the window gives, or
  // after a second at 80 by 24.
  open(viewer: TerminalViewer, cwd: string | null, program?: Program): TerminalInfo {
    const folder = program === undefined ? (cwd ?? this.options.home) : this.options.home;
    const file = program?.file ?? this.options.shell;
    // A login shell, which reads the user's profile as macOS's Terminal does.
    const args = program?.args ?? ['-l'];
    const info: TerminalInfo = {
      id: randomUUID(),
      cwd: folder,
      program: program === undefined ? basename(file) : [basename(file), ...args].join(' '),
    };
    let end: (code: number) => void = () => undefined;
    const ended = new Promise<number>((resolve) => {
      end = resolve;
    });
    const running: Running = {
      info,
      start: { file, args, cwd: folder },
      pty: null,
      typed: [],
      fallback: setTimeout(() => {
        this.begin(running, COLUMNS, ROWS);
      }, SIZE_WAIT_MS),
      viewer,
      shell: program === undefined,
      exited: false,
      ended,
      end,
    };
    this.running.set(info.id, running);
    return info;
  }

  write(viewer: TerminalViewer, id: string, data: string): void {
    const running = this.own(viewer, id);
    if (running.exited) return;
    if (running.pty === null) running.typed.push(data);
    else running.pty.write(data);
  }

  resize(viewer: TerminalViewer, id: string, columns: number, rows: number): void {
    const running = this.own(viewer, id);
    if (running.exited) return;
    const wide = Math.min(Math.max(1, Math.floor(columns)), MAX_COLUMNS);
    const high = Math.min(Math.max(1, Math.floor(rows)), MAX_ROWS);
    if (running.pty === null) this.begin(running, wide, high);
    else running.pty.resize(wide, high);
  }

  // What runs in the terminal that closing it would end: the name of the program in its foreground,
  // when that is not the shell the terminal started with, or the program it started with until that
  // ends; null when nothing would end but the shell.
  busy(viewer: TerminalViewer, id: string): string | null {
    const running = this.own(viewer, id);
    if (running.exited) return null;
    if (!running.shell) return running.info.program;
    const foreground = running.pty?.process ?? '';
    return foreground === '' || foreground === basename(this.options.shell) ? null : foreground;
  }

  // Resolves with the exit code once the program the terminal started with ends.
  ended(id: string): Promise<number> {
    const running = this.running.get(id);
    return running === undefined ? Promise.reject(new Error('No such terminal.')) : running.ended;
  }

  // Ends the terminal and whatever runs in it.
  close(viewer: TerminalViewer, id: string): void {
    const running = this.running.get(id);
    if (running?.viewer.id !== viewer.id) return;
    this.end(id, running);
  }

  // Ends the terminals a window opened, as the window goes or loads its page anew.
  closeViewer(viewerId: number): void {
    for (const [id, running] of this.running) {
      if (running.viewer.id === viewerId) this.end(id, running);
    }
  }

  // Ends every terminal, as the app quits.
  closeAll(): void {
    for (const [id, running] of this.running) this.end(id, running);
  }

  // Starts the terminal's program at the size, with what the user typed meanwhile.
  private begin(running: Running, columns: number, rows: number): void {
    clearTimeout(running.fallback);
    if (running.pty !== null || this.running.get(running.info.id) !== running) return;
    const { file, args, cwd } = running.start;
    const pty = this.spawn(file, args, { cwd, columns, rows, env: this.options.env });
    running.pty = pty;
    const { id } = running.info;
    pty.onData((data) => {
      if (this.running.get(id) === running) running.viewer.output(id, data);
    });
    pty.onExit((code) => {
      running.exited = true;
      running.end(code);
      if (this.running.get(id) === running) running.viewer.exit(id, code);
    });
    for (const data of running.typed.splice(0)) pty.write(data);
  }

  private end(id: string, running: Running): void {
    this.running.delete(id);
    clearTimeout(running.fallback);
    if (!running.exited) running.pty?.kill();
  }

  // A window reaches only the terminals it opened.
  private own(viewer: TerminalViewer, id: string): Running {
    const running = this.running.get(id);
    if (running?.viewer.id !== viewer.id) throw new Error('No such terminal in this window.');
    return running;
  }
}
