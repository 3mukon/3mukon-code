---
id: L-0010
type: lesson
title: Keep rendering free of subscriptions and cleanup distinct from user input
status: active
visibility: public
date: 2026-11-07
summary: Development lifecycle replay can turn a dialog cleanup into a false cancellation and leave constructor subscriptions buffering output forever, so subscribe in effects with cleanup and ignore stale dialog close events
scope: ["src/ui/renderer/question*", "src/terminal/renderer/**", "src/app/renderer/**"]
tags: []
level: test
occurrences: 1
---

## Symptom

```text
Closing a terminal running an interactive program briefly shows a confirmation, then it disappears
without an answer and the terminal panel stays open. A development render also registers two
terminal output listeners where one is expected.
```

## Root cause

The application root enables React StrictMode. In development, it can call a state initializer twice and replay an effect's setup, cleanup and setup. The dialog effect opens with `showModal()` and cleans up with `close()`. Closing queues a browser event, which can arrive after the replay has reopened the same element. The unconditional close handler answered Cancel for that stale event. This affects the shared question component, not the terminal program's output protocol.

The shell also constructed `TerminalViews` in a state initializer. That constructor registered output, exit and appearance listeners with no teardown. The discarded instance stayed subscribed and had no emulator to consume its early output queue. Every output chunk copied the entire queue again, amplifying allocation and copying as output accumulated.

See [React StrictMode](https://react.dev/reference/react/StrictMode) for lifecycle replay and the [HTML dialog close steps](https://html.spec.whatwg.org/multipage/interactive-elements.html#close-the-dialog) for queued close delivery.

## Why it looked right

A dialog's close normally means cancellation, and cleaning up the dialog is necessary. A lazy state initializer looks like a place to create a once-per-shell service. Existing tests did not wrap these cases in StrictMode, happy-dom fires close synchronously rather than as a browser task, and production smoke builds do not replay development effects.

## Fix

- The question tracks whether its effect is active and checks that the dialog is still closed when a close event arrives. Cleanup and a stale event after reopening cannot answer it. The default answer, Escape and explicit cancellation remain unchanged.
- `TerminalViews` construction is pure. Its `connect()` runs from an effect and returns cleanup for all subscriptions, preserving the emulator across reconnects. Early chunks append to their queue rather than copying all earlier chunks.
- The question tests model queued browser close events and synchronous cleanup under StrictMode; the app test asserts one live output/exit subscription and none after unmount; the terminal-view test checks early/live output order and reconnect without a new emulator.

## Occurrences

- 2026-11-07: terminal close confirmations and terminal-view initialization under the application root's development lifecycle replay; reproduced with non-window component tests.
