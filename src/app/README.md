---
id: DOC-mod-app
type: doc
title: app module
status: current
visibility: public
date: 2026-10-25
summary: The Electron entry point, which starts the desktop app, opens its main window on the app's own page and lays out the window shell
scope: ["src/app/**", "tests/smoke/**"]
tags: []
---

## Responsibilities

- Lifecycle (`main/index.ts`): opens the main window once Electron is ready, and again when the Dock icon is clicked while no window is open. The app keeps running without windows until the user quits it, as macOS apps do.
- The main window (`main/window.ts`): a hidden-inset title bar with the native traffic lights, and a renderer with context isolation, the OS sandbox and no Node.js integration. Under `electron-vite dev` it loads the renderer dev server; otherwise, and always when packaged, the built page.
- Navigation: the window opens no other windows and never leaves the app's page. Links to `http:` and `https:` URLs open in the default browser (`main/links.ts`); other links are dropped.
- The renderer (`renderer/`): the page with its content security policy. `main.tsx` starts the i18n module and renders the window shell (`app.tsx`): a full-height 220px sidebar, which ⌘B hides and shows, with the workspace label, the Sessions section and New session, disabled until sessions can be started; beside it the main area, blank until sessions arrive. The top 40px of both form the title bar, which moves the window, shows no title and has no line beneath it; the sidebar's divider runs through it and is the shell's only line.
- The application menu, which is Electron's default macOS menu for now.

## Not responsible for

- Feature UI and state, such as sessions: each lives in the feature module that owns it, and this module only composes them. The session list, the panes and the waiting indicator join the shell from the modules that own sessions and approvals, built from the ui module's components.
- Packaging, which `electron-builder.yml` and `scripts/package.sh` configure for the whole repository.

## Interface

None: this module is the entry point, and no other module imports it. When renderer code first needs the main process, this module adds the preload script with its typed bridge, which is then the only way renderer code reaches the main process.

## Dependencies

- May import any feature module, to compose it; no module may import this one, which the rule `app-is-the-entry` in `.dependency-cruiser.js` enforces.
- Today it imports Electron, Node.js built-ins, React, react-i18next and the i18n module.

## Invariants

- The page has no Node.js and its renderer process is sandboxed: `tests/smoke/launch.spec.ts` checks that the page sees neither `require` nor `process` and that macOS reports the renderer process as sandboxed.
- Only web links leave the app: `shell.openExternal` never receives another scheme.
