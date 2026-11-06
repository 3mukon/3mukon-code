---
id: L-0008
type: lesson
title: Let the window draw a drag's end before the drop's work begins
status: active
visibility: public
date: 2026-11-06
summary: A drop whose work runs in the same task as the end of its drag, such as opening a panel and rendering every panel's body again, keeps Chromium from taking the grabbing cursor off the pointer until that work ends, which with long sessions open lasts long enough to look stuck until the mouse moves; end the drag at once, do the drop after the next frame, and keep a drag's passing state from rendering heavy content again
scope: ["src/panels/**", "tests/smoke/panels.spec.ts"]
tags: []
level: test
occurrences: 1
---

## Symptom

```text
After a session or a workspace folder was dragged into a panel and let go, the pointer kept the
grabbing hand until the mouse moved. With three panels showing sessions of 1,500 steps, Chromium
changed the cursor 479 and 572 ms after the release, each time just after a long task that had begun
2 ms after it; with light panels, 3 to 17 ms after it.
```

## Root cause

While a drag goes on, a layer over the window holds the pointer with the grabbing cursor. As the button went up, `PanelArea` removed the layer and opened or moved what was dropped in the same task. Chromium takes the cursor of what lies under the pointer as it next draws a frame, so the new cursor waited for the whole of that task: opening the panel, laying out the area, and rendering every panel's body again. The area handed each panel the body its view gave it on every render of its own, and a page that shows a long session takes hundreds of milliseconds to render, several such pages longer. Until the task ended, the window showed the grabbing hand; the mouse, moved sooner, seemed to be what set it right.

## Why it looked right

The layer's removal and the drop were one change of state, and with light panels the cursor changed within a frame, with Playwright's input and with a real mouse alike, so the delay showed only with long sessions open. macOS seemed the likelier culprit, since Chromium sets its cursor again on each mouse move when the system's differs, which is what a move appeared to do.

## Fix

`PanelArea` ends a drag as the button goes up and opens or moves what it dropped after the next frame (`afterNextFrame`: a frame, then a task), so that the frame that takes the grabbing cursor off the pointer comes first. Each panel's body renders through `PanelBody`, a memoized component that renders again only when the panel or the view does, not with the area's own drag state. `tests/smoke/panels.spec.ts` checks that the pointer leaves the grabbing hand within 500 ms of a drop whose page then holds the main thread for a second, and `src/panels/renderer/panel-area.test.tsx` that a drop waits for the frame and that a drag leaves the panels' bodies as they are.

## Occurrences

- 2026-11-06: a session or a workspace folder dragged into a panel, with long sessions open.
