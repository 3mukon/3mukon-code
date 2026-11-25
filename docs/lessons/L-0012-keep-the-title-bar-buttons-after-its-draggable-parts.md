---
id: L-0012
type: lesson
title: Let no draggable part of the title bar come after a button over it in the document
status: active
visibility: public
date: 2026-11-25
summary: On macOS, Electron applies the page's draggable and non-draggable parts in the document's order, each over those before it, so a button that lies over a draggable part but comes before it in the document takes no presses, whatever its own no-drag and its z-index; put the button after the draggable part, or leave a non-draggable hole in that part beneath it, and check presses with the rule, since Playwright's clicks go past it
scope: ["src/**/renderer/**", "tests/smoke/**"]
tags: []
level: test
occurrences: 1
---

## Symptom

```text
The sidebar's button, the archived sessions' button, the accounts' gauge and the settings' gear did nothing
when clicked, with the sidebar shown or hidden. Every unit and smoke test passed, the smoke test's clicks
on the sidebar's button included.
```

## Root cause

To keep them still as the sidebar opens and closes, the buttons just after macOS's window buttons moved out of the sidebar's part of the title bar and the top-left panel's header, both draggable (`-webkit-app-region: drag`), into a layer of their own above both, first in the document. The buttons declare `no-drag`, but on macOS Electron builds the window's draggable area from the page's parts in the document's order, each over those before it, so the draggable parts that came later covered them, and macOS took each press as the start of a move of the window. A position above them (`z-index`) changes nothing.

## Why it looked right

The buttons were no-drag, as before, and lay above the title bar in the page. Playwright's clicks go to the page through the DevTools protocol, past the window's draggable area, so the smoke test's click on the sidebar's button worked; only a press of the pointer meets that area.

## Fix

The draggable parts that can lie beneath the buttons, the sidebar's part of the title bar, the top-left panel's header while it clears the window buttons and the empty strip while no panel is open, each leave a non-draggable hole inside them beneath the buttons (`WindowButtonsHole` in `src/ui/renderer/pane.tsx`), which comes after them in the document. A smoke test in `tests/smoke/launch.spec.ts` applies Electron's rule at each button's centre, in each of the three layouts.

## Occurrences

- 2026-11-25: the buttons beside the window buttons, after they moved to a layer of their own above the title bar; found by the user's click.
