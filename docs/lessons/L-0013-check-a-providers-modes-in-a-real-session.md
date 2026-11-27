---
id: L-0013
type: lesson
title: Check in a real session what a provider's mode does before mapping the app's settings onto it
status: active
visibility: public
date: 2026-11-27
summary: ADR-0040 mapped the app's sandbox levels onto Antigravity's modes from Antigravity's own description of them and a check of one mode, and Antigravity's auto mode then left its sandbox without asking, which no level allowed; before an ADR maps the app's modes or levels onto a provider's, run each mode it relies on in a real session and record what the provider asks, what it does without asking and what its sandbox lets through
scope: ["src/providers/**"]
tags: []
level: doc
occurrences: 1
---

## Symptom

```text
Antigravity 1.5.18 in the app, auto mode, terminal sandbox on (ADR-0040's auto at workspace-write):
a command the sandbox refused was run again with BypassSandbox: true in its input, and no
session/request_permission reached the app; a file in a temporary folder was deleted with rm
without asking. In default mode, a command writing in the session's folder failed inside the
sandbox, so yolo at workspace-write could not write there at all.
```

## Root cause

ADR-0040 took what auto mode does from Antigravity's own description of it: it proceeds without asking where the terminal sandbox holds an action, and asks to run a command outside it. It took what the sandbox lets through from a check in default mode alone. Both depend on the mode. In auto mode, Antigravity's own review approves leaving the sandbox, and the sandbox lets commands write in the session's folder. In default mode, it lets them write only in the temporary folders.

## Why it looked right

- **The description was the provider's own,** in the mode list `agy acp` returns and in its documentation.
- **The one check matched it.** The check of the sandbox in default mode matched the description's sandbox.
- **The tests agreed.** The adapter's unit tests ran against a fake Antigravity that behaved as described, so every test passed.

## Fix

ADR-0043 no longer maps the app's levels onto Antigravity. Its sessions run Antigravity's own modes, auto and yolo, and the host counts them as levels only where it compares levels.

Before an ADR maps the app's modes or levels onto a provider's, probe each mode it relies on in a real session, in a throwaway folder and home. Run one action within the bounds the mapping assumes and one beyond them, and record what reached the app as a request and what ran without one. The ADR's Context cites those runs, not the provider's description.

## Occurrences
