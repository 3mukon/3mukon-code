---
id: ADR-0034
type: adr
title: Show the foreground control just above the window it is about
status: accepted
visibility: public
date: 2026-11-22
summary: Keep the foreground control just above the window the agent controls and directly above it among the windows on the screen, past a display's edges too, at the top of the display only in full screen, for the whole operation and with a stop shortcut of the helper's own, because the user looks for it at that window and puts other windows in front of both
scope: ["src/app/main/control-window.ts", "src/app/renderer/control-window.tsx", "src/computer/**", "src/toolset/main/broker.ts", "docs/ui.md"]
tags: []
supersedes: []
superseded_by:
---

## Context

[ADR-0027](ADR-0027-browser-and-computer-use-and-closed-panels.md) shows the foreground control above every application and Space, in one place on the display where the agent works, which the app took as the middle of the top of the display. Used, it lay far from the window it names, over the middle of the top of a tall window, where the agent cannot click under it, and in front of whatever the user put before that window.

Three more things showed in use. The buttons, which are pictures of a page that nobody points at, did not react to the pointer. The stop shortcut did nothing: Electron registers ⌃⌥⌘. on the number pad's decimal key, where the period key types the period. And the control showed only during each action, so that between two of them the user had neither Stop nor the shortcut.

## Options

| Option | Disposition |
|---|---|
| Place: just above the window, in the middle of it, wherever it is, and at the top of the display in full screen | Chosen: the control stays next to what it names, covers nothing of it and moves as a part of it. |
| Place: the same, kept within the display, and at its top where there is no room above the window | Rejected: the control would leave its window just as that is moved to an edge, and cover what is at the display's top. |
| Place: at the top of the display | Rejected: on a large display it is far from the window, and it covers the top of a tall one. It stays the place in full screen, where there is nothing above the window. |
| Place: inside the window's top edge | Rejected: it covers the window's own title bar and tools, which the agent then cannot use. |
| Place: above the window where that was as the control came to show | Rejected: a user who takes over and moves the window would leave the control behind. |
| Order: directly above the window | Chosen: what the user puts in front of the window covers the control too. |
| Order: above every application | Rejected: it covers what the user works in, and seems to belong to the window under it. |
| Placed by the app, which the helper tells of each move | Rejected: each step of a move would pass through two processes, where the helper, which shows the control, sees the window itself. |
| Attached to the window, so that macOS moves the two together | Not available: macOS attaches only a process's own windows. |
| Shortcut: Electron's global shortcut | Rejected: for the period it registers another key, and gives no way to name the key. |
| Shortcut: a hot key that the helper registers with macOS | Chosen: it names the key itself, comes from any application, and needs no permission. |
| Shortcut: found in the input that the helper monitors | Rejected: it would need the monitor to run between actions as well, and Secure Input hides the keys from it. |
| Shown during each action alone | Rejected: what stops the agent would come and go. |

## Decision

The control is directly above the window it is about among the windows on the screen: a window that covers that one covers the control, and one behind it is behind both. Windows that macOS keeps together with the window, as its title bar in full screen, stay between the two.

It lies just above the window's top edge, in the middle of it, and moves with the window, whoever moves it and in every state. It is not kept within the display: where the window is partly past an edge, or under the menu bar, the same part of the control is too. It is on the screen while its window is, on that window's Space. A window in full screen has nothing above it, so there the control lies at the top of the display, in the middle of it, or of the window's half in Split View. The helper, which shows the control, places it: the app gives it the pictures and names the window.

A change of state moves nothing: the control that turns from acting to paused, or back, stays where it is, with **Stop** within reach.

The buttons show the pointer over them and a press. The page draws the control at rest, under the pointer and pressed, and the helper shows each button's own picture for its state.

⌃⌥⌘. is a hot key that the helper registers with macOS, on the key that types a period on the user's keyboard, while something is in control, also where the control's window is not on the screen. A press stops whoever is in control, whichever picture of the control shows. The helper says as it starts whether macOS registers it.

The control, and with it the shortcut, stays between the actions of a foreground operation until the operation has ended.

This replaces, in ADR-0027, that the control stays above every application and Space and in one place on the display, and in [ADR-0025](ADR-0025-app-owned-native-helper.md) that it stays above other applications, Spaces and full-screen windows and that the app passes its frame to the helper. All else they say of the control stays: it never takes the focus, names the session and the application, and has the same size in acting and paused.

## Consequences

- The control is with the window the user has to watch, on any display and Space, and out of the way of what the user puts in front of that window.
- Above a window that fills the display without being in full screen there is only the menu bar, so its control is out of sight, as it is behind another window. The shortcut, the session's **Stop** and the preview's **Hand Back** remain.
- A window that leaves the screen, as a minimized one does, takes its control along. The shortcut remains.
- The helper reads the window's place and order sixty times a second while the control shows, which takes one to four percent of one core, and twice as often while the window moves.
- Following is a step behind macOS: while a window is dragged, the control trails it by a frame or two, some ten points at a hand's speed.
