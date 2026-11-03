---
id: DOC-mod-i18n
type: doc
title: i18n module
status: current
visibility: public
date: 2026-10-25
summary: The English and Simplified Chinese catalogs, and the runtimes that show the window and the main process's dialogs and menus in the first of them that macOS's preferred languages name
scope: ["src/i18n/**"]
tags: []
---

## Responsibilities

- The catalogs (`catalogs/en.json`, `catalogs/zh-Hans.json`): every UI string, under nested keys, in both languages, for the window and for the main process's dialogs and menus. `scripts/checks/catalogs.sh` keeps their keys equal, and TypeScript checks every key the code uses against the English catalog (`shared/i18next.d.ts`), in both processes.
- The language choice (`shared/language.ts`): among the preferred languages, most preferred first, the first English or Simplified Chinese one; English if there is none.
- The window's runtime (`renderer/i18n.ts`): `initI18n` starts i18next for react-i18next in the language `resolveLanguage` picks from `navigator.languages`, which in Electron lists the languages preferred in macOS's settings, and sets the page's `lang` so that VoiceOver uses a matching voice.
- The main process's runtime (`main/i18n.ts`): `mainTranslator` gives a translation function, `Translate`, in the language picked from the languages it is given. Its text goes to native dialogs and to the menus and questions a window's page draws, which show it as text, never as markup, so values are not escaped.

## Not responsible for

- Which languages the main process passes: the app module gives the locale and then macOS's preferred languages, so that both processes pick the same language.
- Choosing the language by hand: the override arrives with the settings module.

## Interface

- `initI18n(preferred?)` from `renderer/i18n.ts`, called once by the app module before React renders. Components translate with react-i18next's `useTranslation`.
- `mainTranslator(preferred)` and `Translate` from `main/i18n.ts`, for main-process code.
- A new string goes into both catalogs in the same change.

## Dependencies

- Uses i18next and react-i18next and imports no other module; the rule `i18n-imports-no-module` in `.dependency-cruiser.js` enforces it.
- Every other module may import it.
