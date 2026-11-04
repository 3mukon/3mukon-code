---
id: ADR-0019
type: adr
title: Give the packaged app the login shell's PATH, and nothing else of the shell's environment
status: accepted
visibility: public
date: 2026-11-04
summary: As it starts, the packaged app reads the PATH the user's login shell sets, from an interactive login shell's own printenv between two marks within five seconds, and runs the providers and terminals with it, since an app opened from the Finder has macOS's minimal PATH, which the agents' commands outgrow; taking the shell's whole environment, which may hold the credentials a profile exports, a fixed list of folders and asking the user to set launchd's PATH were rejected
scope: ["src/app/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

An app opened from the Finder or the Dock starts with launchd's environment, whose PATH is `/usr/bin:/bin:/usr/sbin:/sbin`. The agents run commands for the user, such as git, node, pnpm and tools installed with Homebrew, nvm or asdf, through the providers' processes, which inherit the app's environment, and so do the providers' own helpers. In a terminal those commands are found, because the user's shell startup files set PATH. The development build, started from a terminal, already has that PATH. Invariant 9 keeps the app from reading or passing provider keys and tokens, which users often export in the same startup files.

## Options

- The login shell's PATH alone (chosen): run the user's shell once as an interactive login shell, which reads the startup files a terminal does, have it print its PATH with `/usr/bin/printenv` between two marks, so that whatever the startup files print is left out and fish's PATH prints as other shells' does, and take that PATH.
- The login shell's whole environment, as the shell-env packages and some editors take it: the agents would see what a terminal sees, but the app would read every variable the startup files export, provider keys and tokens included, which invariant 9 rules out.
- A fixed list of folders, such as Homebrew's: misses nvm's, asdf's and the user's own folders.
- Asking the user to set PATH for launchd: a step outside the app, which macOS forgets at each restart unless scripted.

## Decision

As the packaged app starts, while its toolset starts, it runs the user's login shell, `$SHELL` or the account's own, with `-ilc`, reads the PATH between the marks within five seconds, keeps its absolute folders and sets them as its own PATH, before any provider or terminal starts. A shell that fails, takes longer or prints no PATH leaves the app's PATH as it was. The development build, started from a terminal, is left as it is.

## Consequences

- Easier: the agents find the user's tools in a packaged app as they would in a terminal.
- Harder: the app starts up to five seconds later when the user's shell is slow to start, and runs the user's startup files once at each launch.
- Must stay true: nothing of the shell's environment but PATH reaches the app.

## Revisit when

A provider needs more of the user's environment than PATH to run the user's tools, or macOS gives apps the user's PATH.
