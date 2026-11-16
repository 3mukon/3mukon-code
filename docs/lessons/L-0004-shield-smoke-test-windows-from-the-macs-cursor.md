---
id: L-0004
type: lesson
title: Shield a smoke test's windows from the Mac's own cursor
status: active
visibility: public
date: 2026-11-04
summary: A smoke test's window hears the Mac's own cursor as well as Playwright's input, even when it ignores the mouse, and its page's one pointer follows both, so a test that hovers or drags fails at random while someone uses the Mac; every smoke test launches the app through the smoke tests' launchers, which lay a transparent window over each of its windows to take the cursor, and the lint refuses any other launch
scope: ["tests/smoke/**"]
tags: []
level: design
occurrences: 2
---

## Symptom

```text
tests/smoke/sessions.spec.ts, the read ahead and the drags from the Sessions list: about one run in
four failed while the Mac was in use, each time at another step.
expect(received).toEqual(expected): Array ["first"] expected, Array [] received
expect(locator).toHaveAttribute(expected): region 'Write the docs', element(s) not found
expect(locator).toHaveCount(expected): 2 expected
Every run passed while the cursor lay elsewhere or the screen was locked.

tests/smoke/settings.spec.ts, the gear's tooltip after a restart: failed in the check command, then
in two of three runs alone, while the Mac was in use.
expect(locator).toHaveText(expected) failed: locator('[data-tooltip]'), "设置" expected,
element(s) not found
```

## Root cause

Chromium passes the Mac's own cursor to the page of a window it lies over: as the cursor moves over the window, and as the window shows, moves or hides under the cursor at rest. `setIgnoreMouseEvents(true)` on the window does not stop it; only another window lying above it at the cursor keeps it away. A page has one mouse pointer, which the cursor's events move just as Playwright's input does, since that input reaches the page through the DevTools protocol. A move of the cursor within the 150 ms the pointer rested on a row fired `pointerleave`, which cancelled the read ahead (`useReadAhead` in `src/sessions/renderer/rows.ts`); a move with no button down between Playwright's press and release ended the drag in `PanelArea`, which takes it for a release the window did not hear, so nothing dropped. With one person's mouse, both are what the app should do.

## Why it looked right

Playwright drives the page through the DevTools protocol and keeps it focused with focus emulation, so a test seems sealed off from the desktop, and nothing moves the mouse on a CI runner or an idle Mac. The failures moved from step to step and looked like a race in the read ahead's timer or the drag's pointer handling, though each failing step was the app doing what it should. The window covers most of a laptop's screen, so almost any use of the mouse lands on it.

A test that only clicked seemed to need no shield, so the lesson first let such a test launch the app itself, and named the settings' test as one. Three days later the tooltips gave that test three hovers, and nothing checked that it still only clicked. A test that only clicks is not safe either: a click of the user's own reaches a window without a shield.

## Fix

`launch()` in `tests/smoke/app.ts`, and so `withApp()`, lays a shield over each window of the app it starts: a transparent `BaseWindow`, a child of the window, without a page and taking no focus, which takes the cursor and its clicks while Playwright's input still reaches the page. It shows as the window becomes ready to show, just before the app shows the window, so that the window never appears bare under a cursor at rest, and follows the window as it moves and resizes. It is a `BaseWindow` because a `BrowserWindow` would add a page that `firstWindow()` can return and a window to `BrowserWindow.getAllWindows()`. Every smoke test launches the app through these functions, or through `launchWith()`, which also takes variables added to the isolated environment and a page that follows macOS's appearance, so no test needs to launch the app itself. The lint (`eslint.config.mjs`) refuses Playwright's `_electron` in any other file of `tests/smoke/`.

The shield's lifecycle also ends when either native window closes. During quit, the child may close
first while the parent still emits a queued show/move/resize event. The launcher detaches those
listeners and checks both native objects before accessing them; `tests/smoke/shield.spec.ts` exercises
that order without weakening pointer isolation while the test runs. Otherwise an exception in a
late callback opens Electron's modal error box and makes a successful UI assertion time out in
cleanup.

## Occurrences

- 2026-11-04: the Sessions list's read ahead and drags in `tests/smoke/sessions.spec.ts`, which also failed the check command now and then.
- 2026-11-15: the gear's tooltip after a restart in `tests/smoke/settings.spec.ts`. The test launched the app itself, without the shield, as the lesson then let a test that only clicks do, and had hovered since the tooltips arrived (`d140347`). Its guardrail moved from the lesson's word to the lint, and every smoke test now launches through the shield.
