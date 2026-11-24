---
id: DOC-mod-settings
type: doc
title: settings module
status: current
visibility: public
date: 2026-11-03
summary: The app's settings, the window's language, its appearance, whether its tooltips show and whether its sidebar is hidden, kept in the app's own data, with the panel that changes them in the e-ink look and the hook that keeps the window's language in step with them
scope: ["src/settings/**"]
tags: []
---

## Responsibilities

- The contract (`shared/settings.ts`): `AppSettings`, the language, `system` for macOS's preferred languages or `en` or `zh-Hans`, the appearance, `system`, `light` or `dark`, `tooltips`, whether the window draws its controls' tooltips (ADR-0021), and `sidebarHidden`, whether the window's sidebar is hidden, as its button and ⌘B leave it, which the panel does not show; `settingsOf`, which takes the settings from a value of any shape, what is not one of the choices giving way to the default (`defaultSettings`, System for the first two, the tooltips off and the sidebar shown); `sameSettings`, whether two sets of settings choose the same in every setting; `preferredLanguages`, the preferred languages a choice of language stands for; and `SettingsBridge`, what the window asks of the settings through the preload bridge: the settings it opened with, without a call, reading and changing them, and hearing each change.
- The store (`main/settings.ts`): `Settings` keeps the settings in `settings.json` in the app's data, readable by the user alone (`settingsStorage`), and tells its listeners whenever a change changes them; a change to what they are already, in every setting, changes nothing.
- The panel (`renderer/settings-panel.tsx`): `SettingsPanel`, the settings as a panel shows them on the window's paper, each a row of choices drawn with the ui module's `Segmented`, the chosen one in ink: the language, System, English or 简体中文, each language named in itself, the appearance, System, Light or Dark, and the tooltips, Off or On, each with a line of what it does.
- The hook (`renderer/use-settings.ts`): `useSettings` keeps the settings current through the bridge and changes them, and switches the window's language as the language setting changes, through the i18n module.

## Not responsible for

- Applying the appearance and the main process's language: the app module sets macOS's appearance for the app (`nativeTheme`), which the page and macOS's own panels follow, and picks its translator's language, as the settings change.
- The settings other modules own, such as browser and computer use, which the app module puts after this module's own as the panel's children.
- Where the settings show: the app module opens them in a panel of the panels module, with ⌘, or the gear just after the archived sessions' button in the title bar.
- Taking a change from the window: the app module's bridge accepts one field by field, each to its choices, and refuses any other (`settingsChange` in `src/app/main/bridge.ts`), so a new setting needs its field there as well.
- Settings for sessions, which their pages hold (the sessions module); the app has no default permission mode or sandbox level.

## Interface

- For the app module: `Settings` and `settingsStorage` from `main/settings.ts`; `SettingsPanel` and `useSettings` from `renderer/`; the types and helpers in `shared/settings.ts`, which the preload bridge also uses.

## Dependencies

- Uses the ui and i18n modules, React and react-i18next, electron-store in `main/`. The rule `settings-only-to-ui-and-i18n` in `.dependency-cruiser.js` enforces it.
- Only the app module imports it.

## Invariants

- The settings live in the app's own data alone, readable by the user alone, and hold no provider's key or token (invariant 9).
- The store, the contract and the panel have unit tests (`main/settings.test.ts`, `shared/settings.test.ts`, `renderer/settings-panel.test.tsx`), and a smoke test changes the appearance and the language in the built app and finds them applied at once and after a restart (`tests/smoke/settings.spec.ts`).
