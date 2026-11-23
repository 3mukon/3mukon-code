---
id: ADR-0032
type: adr
title: Let Chrome's extension and host follow the app's build
status: accepted
visibility: public
date: 2026-11-22
summary: Renew the installed extension, host and registration as the app starts, and have the extension reload itself when its folder names another build than the worker runs, so that an app update needs no step in Chrome
scope: ["src/browser/**", "scripts/**", "tests/contracts/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

The app carries Chrome's extension and native host and installs them in its data folder, from where the user loads the extension once ([ADR-0030](ADR-0030-chrome-profile-task-tabs.md)). That decision left the update and reload of a new version open. The folder was written at the first Connect and kept as it was, so an app update would have left Chrome with the earlier extension, and the host was replaced only at Connect. The app and the extension ship together and change together.

Chrome reads an unpacked extension's manifest as it starts. In Chrome for Testing 158 it then goes on running the service worker it had registered, across restarts and where the manifest's version has changed. Reloading the extension runs the folder's code at once and keeps the extension's storage. An extension can read its own files as they are on disk.

## Options

| Option | Disposition |
|---|---|
| The extension reloads itself when its folder names another build than the one it runs | Chosen. It works while the extension is connected to nothing, needs no message that two builds must agree on, and lets the app write files only. |
| The app asks the connected extension to reload | Rejected: it reaches only an extension that connects, and both builds must understand the request. |
| Compare the manifest's version | Rejected: Chrome reports the new version while it runs the old worker, and the number would have to be raised by hand at each change. |
| Keep the channel compatible across builds | Rejected: both sides come from one app, and the old extension would stay in Chrome. |
| Ask the user to reload or load the folder again after each update | Rejected: loading the folder is a step of the first setup. |

## Decision

Packaging names the extension's build by a hash of its files in `build.js`, which the worker imports, so the name belongs to the code that runs.

As it starts, before Chrome can connect, the app renews what Connect installed: the extension's files with `build.js` last, the host, and the host's registration where it is this app's own. Each file that differs is replaced in one step. What Connect has not installed, and a registration another app made, stay as they are.

The worker compares its build with its folder's as it starts, at each retry of a saved connection and when the setup page asks for the extension. If they differ, it reloads the extension: once for each build and run of Chrome, and never while it has a connection, whose task tabs a reload would leave behind.

Pairing and restoring name the build, and the app closes a connection of any other build. The setup page counts an extension of another build as missing once it has had two seconds to reload, and the app then offers the folder to load.

## Consequences

- An app update needs no step in Chrome. A saved connection is back within the extension's half-minute retry, and Connect finds a reloaded extension in about a second. Going back to an earlier app build works the same way.
- An extension that Chrome loaded from another folder cannot follow. Its saved connection keeps waiting, and Disconnect and Connect lead to loading the app's folder.
- The channel between the app and the extension can change with any build, without support for another.
- Every file of the extension counts towards its build. The worker never reloads with a connection open, and `build.js` is written after the files it stands for.

## Revisit when

The extension comes from a store that updates it, or Chrome refreshes an unpacked extension's worker by itself.
