import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import type { TerminalBridge } from '../shared/terminal';

// What a terminal says once its program ends, in the window's language.
export type ExitNote = (code: number) => string;

interface View {
  terminal: Terminal;
  fit: FitAddon;
  // The element the emulator draws in, which moves into whichever panel shows the terminal, so that
  // moving or splitting the panel keeps what the terminal shows.
  element: HTMLDivElement;
  opened: boolean;
}

// How many lines a terminal keeps above what shows, in memory while its panel is open.
const SCROLLBACK = 5_000;

// The window's terminals as xterm.js draws them (ADR-0015), one emulator per terminal, kept while the
// terminal's panel is open and moved with it; a terminal's program starts once its emulator gives its
// size. What a terminal prints goes to its emulator, held until
// the emulator exists, and what the user types goes back through the bridge; nothing else reads or
// keeps either (ADR-0016). The emulators take their colours and font from the tokens, and take them
// anew when the appearance changes.
export class TerminalViews {
  private readonly views = new Map<string, View>();
  // What terminals printed, and the exits of their programs, before their emulators existed.
  private readonly early = new Map<string, string[]>();
  private readonly exits = new Map<string, number>();

  constructor(
    private readonly bridge: TerminalBridge,
    private readonly exitNote: ExitNote,
  ) {
    bridge.onOutput((id, data) => {
      const view = this.views.get(id);
      if (view !== undefined) view.terminal.write(data);
      else this.early.set(id, [...(this.early.get(id) ?? []), data]);
    });
    bridge.onExit((id, code) => {
      const view = this.views.get(id);
      if (view !== undefined) view.terminal.write(`\r\n\x1b[2m${this.exitNote(code)}\x1b[22m\r\n`);
      else this.exits.set(id, code);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const theme = themeFromTokens();
      for (const view of this.views.values()) view.terminal.options.theme = theme;
    });
  }

  // Shows the terminal in the host element, the emulator drawing in it from now on; returns a function
  // that takes it out again, keeping the emulator for the next host. A terminal shown for the first
  // time takes the keyboard.
  show(id: string, host: HTMLElement): () => void {
    const view = this.views.get(id) ?? this.create(id);
    host.append(view.element);
    const first = !view.opened;
    if (first) {
      view.terminal.open(view.element);
      view.opened = true;
      for (const data of this.early.get(id) ?? []) view.terminal.write(data);
      this.early.delete(id);
      const code = this.exits.get(id);
      if (code !== undefined) {
        view.terminal.write(`\r\n\x1b[2m${this.exitNote(code)}\x1b[22m\r\n`);
        this.exits.delete(id);
      }
    }
    this.fit(id);
    if (first) {
      // The terminal's program starts at the size the emulator first takes, which the emulator
      // reports only when it differs from its own default.
      this.bridge.resize(id, view.terminal.cols, view.terminal.rows).catch(report);
      view.terminal.focus();
    }
    return () => {
      view.element.remove();
    };
  }

  // Fits the terminal to its host, which tells its program the new size.
  fit(id: string): void {
    const view = this.views.get(id);
    if (view?.opened !== true || !view.element.isConnected) return;
    view.fit.fit();
  }

  focus(id: string): void {
    this.views.get(id)?.terminal.focus();
  }

  // Forgets the terminal, as its panel closes.
  dispose(id: string): void {
    this.views.get(id)?.terminal.dispose();
    this.views.delete(id);
    this.early.delete(id);
    this.exits.delete(id);
  }

  private create(id: string): View {
    const terminal = new Terminal({
      theme: themeFromTokens(),
      fontFamily: monospaceFont(),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: SCROLLBACK,
      cursorBlink: true,
      // A clear background, so that the window's paper and its grain show through.
      allowTransparency: true,
      // Bold text keeps its colour, so that bold in the paper's ink does not fade to the faint one.
      drawBoldTextInBrightColors: false,
      // Option-arrow and the like stay macOS's text moves, as in macOS's own Terminal.
      macOptionIsMeta: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // ⌘-click opens a web link, as macOS's Terminal and other editors' terminals do, so that a plain
    // click selects.
    terminal.loadAddon(
      new WebLinksAddon((event, url) => {
        if (event.metaKey) this.bridge.openLink(url).catch(report);
      }),
    );
    // ⌃` opens another terminal, which the window does, so the emulator leaves it alone.
    terminal.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.code === 'Backquote'));
    terminal.onData((data) => {
      this.bridge.write(id, data).catch(report);
    });
    terminal.onResize(({ cols, rows }) => {
      this.bridge.resize(id, cols, rows).catch(report);
    });
    const element = document.createElement('div');
    element.className = 'h-full w-full';
    const view: View = { terminal, fit, element, opened: false };
    this.views.set(id, view);
    return view;
  }
}

// The emulator's colours in the e-ink look, from the tokens as the page now has them (DOC-mod-ui): ink
// on the window's own paper, whose grain shows through the emulator's clear background, and colour
// kept for what it means, red, green and yellow for errors, additions and warnings; blue, magenta and
// cyan in the paper's softer ink, their bright forms in full ink, rather than hues that change with
// the appearance. Black and white take the paper's and the ink's sides of the appearance, so that both
// stay readable. The selection is the darker paper the user's messages sit on, and the scroll bar is
// drawn in the lines' ink.
export function themeFromTokens(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const ink = token('ink');
  const soft = token('muted');
  const faint = token('faint');
  return {
    background: 'rgba(0, 0, 0, 0)',
    foreground: ink,
    cursor: ink,
    cursorAccent: token('frame'),
    selectionBackground: token('bubble'),
    selectionInactiveBackground: token('bubble'),
    scrollbarSliderBackground: token('line'),
    scrollbarSliderHoverBackground: token('menu-line'),
    scrollbarSliderActiveBackground: token('menu-line'),
    black: dark ? faint : ink,
    red: token('del'),
    green: token('add'),
    yellow: token('wait'),
    blue: soft,
    magenta: soft,
    cyan: soft,
    white: dark ? ink : faint,
    brightBlack: faint,
    brightRed: token('del'),
    brightGreen: token('add'),
    brightYellow: token('wait'),
    brightBlue: ink,
    brightMagenta: ink,
    brightCyan: ink,
    brightWhite: dark ? ink : soft,
  };
}

// The tokens' monospaced font, SF Mono on macOS.
function monospaceFont(): string {
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return font === '' ? 'ui-monospace, monospace' : font;
}

function report(error: unknown): void {
  console.error('The terminal could not do that:', error);
}
