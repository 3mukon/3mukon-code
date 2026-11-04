---
id: ADR-0016
type: adr
title: Treat a terminal as a pipe between the user and its programs, which the app never reads, keeps or logs
status: accepted
visibility: public
date: 2026-11-04
summary: What runs in a terminal panel and what it prints pass between the pseudo-terminal and the window's emulator without the app reading, keeping or logging them, and are gone when the panel closes, so that a terminal, the providers' sign-in commands included, stays within invariant 9 as it is worded; changing the invariant, leaving sign-in to macOS's Terminal, reading the sign-in commands' output and the providers' programmatic sign-ins were rejected
scope: ["src/terminal/**", "src/accounts/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

Invariant 9 says the app never stores, logs or shows a provider's API key or token, and reads or passes one only to hand a selected Codex gateway file's settings to Codex. A terminal panel is general: the user runs whatever they like in it, and a program may print a key or a token, or read one the user types, as some providers' commands do. The app also opens a terminal on each provider's own sign-in command, which signs in in the user's browser or with a code and stores what it gets in the provider's own settings. The maintainer chose to keep the invariant's wording.

## Options

- The terminal as a pipe (chosen): the window's emulator draws what the pseudo-terminal prints and sends back what the user types; the app's own code passes both on without reading, keeping or logging them. A sign-in runs the provider's own command, which keeps the credential in the provider's own settings, where the provider's sessions read it.
- Adding an exception for terminals to invariant 9: rejected by the maintainer, who keeps its wording.
- Running the sign-in commands in macOS's Terminal instead of a panel: keeps the app out of the way, but takes the user out of the app, which the panel exists to avoid.
- Running the sign-in commands without a terminal and reading their output for the address to open or the code to show: the app would read output that may carry a code or a token, and would break whenever a provider changes its wording.
- The providers' programmatic sign-ins, such as Codex's `account/login/start` and Grok Build's `x.ai/auth/get_url` and `x.ai/auth/submit_code`: the app would carry the sign-in's addresses and codes itself, and each provider would need a flow of its own.

## Decision

A terminal is a pipe between the user and the programs in it. The main process creates the pseudo-terminal, sends what it prints to the one window that shows it, and writes to it what that window sends; it keeps nothing of either, but what the user types before the program has started, which it hands to the program as it starts, and never parses, searches or logs them. The window's emulator keeps a scrollback in memory while the panel is open, and it is gone when the panel closes; nothing of a terminal is written to the app's data, and terminals do not come back after a restart. The app reads only what it needs to manage the panel: whether the program has ended and its exit code, and the name of the foreground program, to ask before ending one that is not the shell. Text leaves a terminal only when the user copies it or opens a link in it. The sign-in commands run from the binaries the providers' sessions run with, in the user's home folder, with the app's environment and nothing added to it but the terminal's own variables.

## Consequences

- Easier: the user signs in with each provider's own command, inside the app, and keeps a general terminal beside their sessions.
- Harder: the app cannot help with a sign-in beyond starting its command and checking afterwards whether it worked.
- Must stay true: no code reads a terminal's output or input for its content; no terminal output or input reaches a log, a file, the app's data or another window; a sign-in never passes a credential through the app.

## Revisit when

A provider offers a sign-in that the app could start and finish without seeing any code or credential, or the maintainer changes invariant 9.
