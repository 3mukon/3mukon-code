---
id: L-0002
type: lesson
title: Close a menu that a press opens yourself, not with a popover's light dismiss
status: active
visibility: public
date: 2026-11-03
summary: A context menu drawn as an automatic popover shows while the secondary button is still down, since macOS asks for the menu at the press, and the browser's light dismiss then closes it at the release, which lands beside it; draw such menus as manual popovers that close themselves, and test them with the button held as a person holds it
scope: ["src/**/renderer/**", "tests/smoke/**"]
tags: []
level: test
occurrences: 1
---

## Symptom

```text
A right-click on a workspace or a session showed its menu, which disappeared at once.
Held until the menu showed, then released: the menu was gone 300 ms later.
```

## Root cause

On macOS the page gets `contextmenu` as the secondary button goes down. The main process's menu reaches the page a few milliseconds later, before a person lets the button go, and the ui module's `Menu` showed it as a `popover="auto"`. An automatic popover's light dismiss closes it when a press and its release both land outside it: the press that asked for the menu came before the menu existed, and the release landed on the row beside it, so the release closed the menu that had just opened.

## Why it looked right

Light dismiss closes a popover at a click beside it, Escape included, which is what a menu wants, and the selects' lists use it well, because they open at a click, after the release. The smoke test right-clicked with Playwright's `click({ button: 'right' })`, which lets the button go at once, before the menu arrives; unit tests run on happy-dom, which has no popovers.

## Fix

`Menu` (`src/ui/renderer/menu.tsx`) is a `popover="manual"` that closes itself, with a comment saying why: at Escape, at a press or a turn of the wheel beside it, and as the window loses the focus or changes size, but never at the release of the press that asked for it. The smoke tests in `tests/smoke/sessions.spec.ts` and `tests/smoke/workspaces.spec.ts` open a session's and a workspace's menu with the button held down until the menu shows, then let it go, and check that the menu stays.

## Occurrences

- 2026-11-03: the session and workspace menus, first drawn in the page.
