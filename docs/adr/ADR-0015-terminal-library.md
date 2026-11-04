---
id: ADR-0015
type: adr
title: Run terminals in pseudo-terminals from node-pty in the main process, and draw them with xterm.js
status: accepted
visibility: public
date: 2026-11-04
summary: A terminal panel's shell runs in a pseudo-terminal from node-pty 1.2.0-beta.18 in the main process, whose prebuilt macOS binary loads in Electron without a rebuild, and the window draws it with xterm.js 6 and its fit and web-links addons; node-pty 1.1.0, whose prebuilt spawn helper is packed without its execute bit, its repackagings, building it from source, macOS's script command and other emulators were rejected
scope: ["src/terminal/**", "package.json", "pnpm-workspace.yaml", "electron-builder.yml"]
tags: []
supersedes: []
superseded_by:
---

## Context

A terminal panel runs the user's login shell in a folder, for everyday work and for the providers' own sign-in commands. A program in a terminal expects a pseudo-terminal: one that reads the window's size, draws with colours and cursor moves, and stops on Control-C. Node.js has no pseudo-terminal of its own, so the main process needs a native module, which must load in Electron 44 and, once packaged, sit outside the asar archive and be signed with the app. The window that draws the terminal is sandboxed, loads scripts, styles and fonts only from the app's own files, and takes its colours from the ui module's tokens in both appearances. The app runs on macOS on Apple silicon alone (invariant 8).

## Options

- node-pty with xterm.js (chosen): Microsoft's pseudo-terminal module, MIT, which VS Code's terminal runs on. Since 1.0 it is built on Node-API, whose binaries load in any Node.js or Electron of a later ABI, and its package carries prebuilt binaries for macOS on Apple silicon: the module and its spawn helper. xterm.js, also MIT and also VS Code's, emulates the terminal in the page with a DOM renderer, takes its colours and font as options, and has addons that fit it to its element and make links clickable.
- node-pty 1.1.0, its latest stable release: its package packs the prebuilt spawn helper without the execute bit, and nothing in the package sets it, so every spawn fails with "posix_spawnp failed". The 1.2 betas pack it executable, and VS Code depends on them.
- Building node-pty from source at install, with node-gyp and electron-rebuild: needs Xcode's command line tools on every machine that installs, and an allowed build script for nothing the prebuilt binary lacks.
- Repackagings with prebuilt binaries, such as @lydell/node-pty and @homebridge/node-pty-prebuilt-multiarch: third parties' copies, which follow upstream late or only as betas.
- macOS's script command, or Python's pty module, as the pseudo-terminal behind pipes: neither can change the terminal's size after it starts, and Python is not part of macOS.
- hterm, Chromium's emulator, or an emulator of the app's own: hterm is no longer published as a package for pages like this one, and writing an emulator is out of proportion.
- xterm.js's WebGL renderer: faster on very large outputs, but it holds a GPU context per panel; the DOM renderer is enough for a shell and a sign-in.

## Decision

The terminal module's main process runs each terminal in a pseudo-terminal from `node-pty` 1.2.0-beta.18, a dependency the build leaves outside the bundle, as it does the providers' packages. Its install script, which only checks for the prebuilt binary or else compiles one, never runs (`allowBuilds` lists it as false), and the module loads its prebuilt binary, which runs a shell at the size it is given in Electron 44.9.3. The window draws each terminal with `@xterm/xterm` 6.0.0 and its DOM renderer, `@xterm/addon-fit` 0.11.0, which sizes it to its panel, and `@xterm/addon-web-links` 0.12.0, whose links open in the browser through the main process, web links alone. Its colours and font come from the tokens and change with the appearance. Packaging keeps node-pty's module and spawn helper outside the asar archive and signs them with the app.

## Consequences

- Easier: a real terminal, with colours, full-screen programs, resizing and Control-C, from code VS Code also runs.
- Harder: a native module and a beta release. Upgrading Electron needs no rebuild while node-pty stays on Node-API, but upgrading node-pty needs a check that its spawn helper is still packed executable. The window's script grows by about 0.35 MB.
- Must stay true: node-pty loads only in the main process; the window reaches a terminal only through the preload bridge; xterm.js loads nothing from the network.

## Revisit when

node-pty publishes a stable release with its spawn helper packed executable, which replaces the beta; or a terminal needs features the DOM renderer cannot draw quickly enough.
