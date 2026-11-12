---
id: DOC-mod-terminal
type: doc
title: terminal module
status: current
visibility: public
date: 2026-11-04
summary: The terminal panels, each the user's login shell or a provider's sign-in command in a pseudo-terminal of the main process, drawn in the window by xterm.js in the e-ink look, which pass what runs in them between the user and its programs without the app reading, keeping or logging it
scope: ["src/terminal/**"]
tags: []
---

## Responsibilities

- The contract (`shared/terminal.ts`): `TerminalInfo`, a terminal's id, the folder it started in and the program it started with; `TerminalBridge`, what the window asks of the terminals through the preload bridge: opening one in a folder, or the home folder, typing into it and sizing it, hearing what each prints and when its program ends, asking whether its panel may close, closing it and opening a web link from it; and the largest size a terminal takes.
- The terminals (`main/terminals.ts`): `Terminals` runs each terminal in a pseudo-terminal (ADR-0015), the user's login shell in a folder or a program, such as a provider's sign-in command, in the home folder, once its panel gives its size, or after a second at 80 by 24, so that the program never draws for another width. What it prints goes to the window that opened it alone, and only that window types into it, sizes it or closes it. It says what closing would end, the program in the shell's foreground or the program it started with until that ends, and when that program ends; it ends a terminal as it closes, the terminals of a window as the window goes or loads its page anew, and all of them as the app quits.
- The native side (`main/native.ts`): `spawnPty` starts a program in a node-pty pseudo-terminal of type xterm-256color; `loginShell` is the user's shell; `terminalEnvironment` is the app's environment with the terminal's type and colours and, where it has none, a UTF-8 locale for the app's region; `windowTerminalUi` asks before a terminal closes while a program runs in it, Cancel by default, as the window draws the question (ADR-0013).
- The emulators (`renderer/terminal-views.ts`): `TerminalViews` keeps one xterm.js emulator per terminal while its panel is open, holding what a terminal prints before its emulator exists, and moves the emulator's element into whichever panel shows it, so that moving or splitting the panel keeps what it shows. It takes its colours and font from the ui module's tokens in the e-ink look and takes them anew as the appearance changes: ink on the window's own paper, whose grain shows through the emulator's clear background, which keeps the paper's colour so that a program asking for the terminal's background, as Codex does to shade its composer and choose its text colours, hears the paper rather than black; red, green and yellow kept for errors, additions and warnings, blue, magenta and cyan in the softer ink, their bright forms in full ink, and bold text in its own colour. It fits the emulator to its panel, which sizes the terminal, sending the first size at once, since the terminal's program starts with it; keeps a new terminal clear until the emulator has taken in its program's first output and no more has followed for 40ms, or until the program ends, or for a second at most, and then fades it in, so that the shell's first prompt shows whole rather than after an empty line with a cursor (`renderer/first-draw.ts`), going by when output comes and never by what it says; opens a web link with ⌘-click through the bridge; leaves ⌃` to the window; says when a program ends; and gives a terminal shown for the first time the keyboard. It hears the terminals' output and exits, and the appearance, only while connected (`connect()`, which the window's shell calls from an effect), and its cleanup stops hearing them while the emulators stay for the next connection, so that one made while rendering and then dropped hears nothing (L-0010); output that comes before a terminal's emulator waits for it in order, each chunk added without copying the ones before.
- The panel (`renderer/terminal-panel.tsx`): `TerminalPanel`, a terminal's emulator in a panel, following its size. Its stylesheet (`renderer/terminal.css`), scoped to the panel, undoes what xterm.js's own stylesheet paints past the emulator's theme: the viewport's black behind the clear background, the white-on-black box in which an input method composes, which takes the darker paper, grain and all, in ink, and the shadow along the top of a scrolled terminal.

## Not responsible for

- Where terminals open and close: the app module opens one with ⌃`, from the menu of a workspace or of a folder inside it, and for a provider's sign-in, as a panel of the panels module, asks the terminal before its panel closes and closes the terminal once its panel has gone.
- Which program a sign-in runs: the accounts module gives each provider's sign-in command, from its adapter.
- Tabs, splits and profiles within a terminal, keeping a terminal's output across restarts, and remote shells.

## Interface

- For the app module: `Terminals` and `TerminalViewer` from `main/terminals.ts`; `spawnPty`, `loginShell`, `terminalEnvironment`, `windowTerminalUi` and `TerminalUi` from `main/native.ts`; `TerminalViews` and `TerminalPanel` from `renderer/`; the contract in `shared/terminal.ts`, which the preload bridge also uses.

## Dependencies

- Uses the ui and i18n modules, node-pty in `main/`, xterm.js with its fit and web-links addons in `renderer/`. The rule `terminal-only-to-ui-and-i18n` in `.dependency-cruiser.js` enforces it.
- Only the app module imports it.

## Invariants

- A terminal is a pipe between the user and its programs (ADR-0016): no code reads what passes through for its content, and nothing of it reaches a log, a file, the app's data or another window. The emulator's scrollback, 5,000 lines, stays in the window's memory while the panel is open.
- node-pty loads only in the main process, and the window reaches a terminal only through the preload bridge (ADR-0015).
- The terminals, the native side and when a new terminal shows have unit tests (`main/terminals.test.ts`, `main/native.test.ts`, `renderer/first-draw.test.ts`, and `renderer/terminal-views.test.tsx` for output before and after a terminal's emulator, in order, across a reconnection), and smoke tests open terminals from a workspace's menu, from a folder's inside it and with ⌃`, check that a new terminal stays clear until its shell has drawn its prompt and that it answers a program asking for its colours with the window's ink and paper in either appearance, run commands in them at their panels' size and close them, asking first while a program runs (`tests/smoke/terminal.spec.ts`).
