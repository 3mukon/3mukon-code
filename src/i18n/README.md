---
id: DOC-mod-i18n
type: doc
title: i18n module
status: current
visibility: public
date: 2026-10-25
summary: The English and Simplified Chinese catalogs and the runtime that shows the UI in the first of them that macOS's preferred languages name
scope: ["src/i18n/**"]
tags: []
---

## Responsibilities

- The catalogs (`catalogs/en.json`, `catalogs/zh-Hans.json`): every UI string, under nested keys, in both languages. `scripts/checks/catalogs.sh` keeps their keys equal, and TypeScript checks every key the code uses against the English catalog (`renderer/i18next.d.ts`).
- The runtime (`renderer/i18n.ts`): `initI18n` starts i18next for react-i18next in the language `resolveLanguage` picks, and sets the page's `lang` so that VoiceOver uses a matching voice.
- The language choice (`renderer/language.ts`): among the preferred languages, most preferred first, the first English or Simplified Chinese one; English if there is none. In Electron, `navigator.languages` lists the languages preferred in macOS's settings.

## Not responsible for

- Choosing the language by hand: the override arrives with the settings module.
- Strings in the main process, such as menu labels: none yet. The catalogs sit outside `renderer/` so that main-process code can use them too.

## Interface

- `initI18n(preferred?)` from `renderer/i18n.ts`, called once by the app module before React renders.
- Components translate with react-i18next's `useTranslation`; a new string goes into both catalogs in the same change.

## Dependencies

- Uses i18next and react-i18next and imports no other module; the rule `i18n-imports-no-module` in `.dependency-cruiser.js` enforces it.
- Every other module may import it.
