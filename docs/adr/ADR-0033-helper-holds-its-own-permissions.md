---
id: ADR-0033
type: adr
title: Let the native helper hold its own macOS permissions
status: accepted
visibility: public
date: 2026-11-22
summary: Have the native helper start itself again in place, responsible for itself, so that its macOS permissions stand on its own signature, outlast app updates and reach nothing else the app starts
scope: ["src/computer/**", "src/app/main/user-setup.ts", "scripts/build-native-helper.sh"]
tags: []
supersedes: []
superseded_by:
---

## Context

[ADR-0025](ADR-0025-app-owned-native-helper.md) packages a named helper with a stable signature, whose permission state names the helper. macOS counts what a process does as the work of its responsible process, which a child takes over from the app that starts it. In the packaged app, every child had the app as its responsible process, a separately signed provider program too. The helper's Accessibility and Screen Recording would so have been the app's: lost with each build that changes the app's ad hoc signature, listed under the app's name, and shared with every provider, command and terminal the app starts, past the app's own grants.

For Screen Recording, macOS 27 also counts a program inside an app's bundle as that app, whatever process is responsible. System Settings lists an app for a permission only once the app has asked for it. For Screen Recording, macOS asks in a prompt whose button opens System Settings and adds the entry, and any window that comes in front covers the prompt. Accessibility reaches a running process at once and Screen Recording only a process that starts after it was allowed. macOS also asks at a first capture, and from time to time, whether an app may go on capturing without the system's picker.

## Options

| Option | Disposition |
|---|---|
| The helper starts itself again in place, disclaiming the app's responsibility | Chosen. It stays the same process on the same private pipes, under its own signature. It needs two private system calls, which browsers and debuggers use for the same purpose. |
| Launch Services starts the helper | Rejected: it would inherit no private pipes, so the channel would need an address of its own and a check of who connects. |
| A registered background service | Rejected: it installs something that outlives the app and needs the user's approval in System Settings. |
| Run the helper inside the app's bundle, responsible for itself | Rejected: Screen Recording would still be the app's. |
| Leave the permissions with the app | Rejected: an update loses them while the app is signed ad hoc, and everything the app starts would share them. |
| An Electron utility process that disclaims responsibility | Rejected: the permissions would stand on Electron's own helper program, which any of the app's code could run, instead of the named helper. |

## Decision

The app installs the helper in its data folder and runs it from there. At each start it compares the installed bundle with the packaged one, replaces it where they differ, and checks the signature of what it runs.

As it starts, before anything asks macOS for a permission, the helper starts itself again in place with the app's responsibility disclaimed. It ends where macOS lacks the calls or still holds another process responsible, so it never works with another program's permissions.

The user's Open System Settings has the helper register its bundle and ask macOS for the permission. Where macOS's prompt comes in front, the app leaves the rest to it, and opens the pane itself otherwise. The settings and the sessions' notices name the helper as the pane lists it, and the helper carries the app's icon.

Where a running helper lacks a permission it needs, the app also reads what a helper that starts now has. A permission that only the new one has waits for a restart, which the settings and a refused call then offer instead of System Settings.

## Consequences

- The permissions outlast an app update as long as the helper's identifier and certificate stay, and a change of either asks the user again. Copies of the app share them.
- Nothing else the app starts can use the helper's permissions.
- A macOS release without the two calls leaves computer use unavailable until the helper gets its responsibility another way.
- A check of a missing permission starts a second helper for a moment.
- The app knows macOS's prompt by the name of the process that owns its window. Under another name, the app opens the pane as well, which covers the prompt.
- macOS's question at a first capture comes when an agent first looks, which follows the user's own setup.

## Revisit when

macOS offers a public way to start a program that is responsible for itself, or the app is distributed with a signature that stays the same across its builds.
