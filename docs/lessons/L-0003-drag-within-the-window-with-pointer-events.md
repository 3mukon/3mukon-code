---
id: L-0003
type: lesson
title: Drag things within the window with the pointer's own events, not with a drag of the system's
status: active
visibility: public
date: 2026-11-03
summary: On macOS, Chromium answers every drag that enters the page with the copy operation until the page's own answer arrives, and a drag whose effect is a copy keeps its copy badge, so a drag that starts and ends inside the window shows the badge for a moment or all along, whatever the page does; drag panels and the items of the app's own lists with pointer events, and keep the system's drag and drop for what comes from the Finder
scope: ["src/**/renderer/**", "tests/smoke/**", "eslint.config.mjs"]
tags: []
level: lint
occurrences: 2
---

## Symptom

```text
Dragging a panel by its title, a plus icon sometimes showed beside the pointer and went away.
Dragging a row from the Workspaces or Sessions list into the panel area, the plus icon showed.
```

## Root cause

The panels and the lists' rows dragged through HTML drag and drop, a drag of the system's. As a drag enters the window's web view, which a drag that begins in it does at once, Chromium's macOS drag destination (`web_drag_dest_mac.mm`) answers AppKit with `NSDragOperationCopy` before the page has handled the event, since AppKit wants an answer at once and the page's comes back later; AppKit draws the copy badge until the page's answer arrives, and again each time the drag comes back into the web view. The panels answered `move`, so the badge only flashed; the rows answered `copy`, as an item opened from a list into a panel had seemed to be, so it stayed.

## Why it looked right

HTML drag and drop moves things between parts of a page, and its drop effect seemed to choose the badge: `move` for the panels, everywhere in the window, and `copy` for the rows, as macOS shows for a file dragged from the Finder into an app. The flash comes from the browser before the page is asked, which no page code can change, and a test sees no cursor.

## Fix

`PanelArea` (`src/panels/renderer/panel-area.tsx`) drags panels and the items of the app's lists with the pointer's own events: a press on a panel's title, or one a list hands it through `dragItem`, drags once the pointer has gone 4 pixels, a layer over the window then holding the pointer with the grabbing cursor and a ghost of what is dragged following it, until the button goes up, Escape is pressed or the window loses the focus; the click that follows the release is not the pressed element's. No drag of the system's starts, so neither the badge nor macOS's slide back of a drag nothing took can show. Items from the Finder still come as the system's drag, whose copy badge macOS shows for them anywhere. ESLint refuses `onDragStart` and a `draggable` that is not `false` in renderer code (`no-restricted-syntax` in `eslint.config.mjs`), and the smoke tests in `tests/smoke/panels.spec.ts` and `tests/smoke/sessions.spec.ts` drag tree rows, sessions and panels and check that no `dragstart` happened.

## Occurrences

- 2026-11-03: the panels moved by their titles.
- 2026-11-03: the rows dragged from the Workspaces and Sessions lists, which the first fix had left to the system's drag; the guardrail moved up from a test to a lint rule.
