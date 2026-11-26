---
id: DOC-mod-installs
type: doc
title: installs module
status: current
visibility: public
date: 2026-11-25
summary: Where each provider's processes come from, the user's CLI on the PATH where its version is one the adapter drives, or else the app's own copy of the provider's official build at the version and checksum the app pins, downloaded into the app's data at a sign-in or session, with what Accounts shows of it
scope: ["src/installs/**"]
tags: []
---

## Responsibilities

- **The adapters' interface** (`main/install.ts`, ADR-0039):
  - `Pin`: the build the app's copy is made from. It holds the CLI's version, the tarball's address and its sha512 integrity, the tarball's folder the copy is made of, and the binary in it, which may come compressed with brotli. Each adapter's `pin.json` holds one, written by `scripts/provider-pins.mjs` from the lockfile.
  - `InstallSpec`: what an adapter says of its CLI, namely its name on the PATH, the oldest version it drives, how to read the version from `--version`, and its pin.
  - `Binary`: a path, a version, and whether it is the user's CLI or the app's copy.
  - `ProviderInstall`: what an adapter and the accounts ask for. `current` gives the binary for any process; `prepare` gives the binary for a sign-in or a session, downloading first where needed; `view` and `onChange` give what Accounts shows.
  - `NotInstalledError`.
- **Choosing the binary** (`main/installs.ts`, `createInstalls`): the choice is made anew for every process.
  - The user's CLI is the first file of the command's name, which the user may run, in the folders the app module gives. Those are the absolute folders of the PATH the app runs providers with (ADR-0019), or in tests their own (`main/find.ts`).
  - It runs where its version is the adapter's oldest or newer. Otherwise the app passes it over and says so: older, or a version it could not read.
  - The app's copy runs where there is no such CLI: the pinned version's copy, or else the newest copy at or above the oldest version. A provider with neither is not installed.
  - `prepare` downloads the pinned copy where the app would run its own and has none of the pinned version. There is one download per provider at a time, which every caller shares. Where it fails, an older copy the adapter drives runs, and the failure stays in the view until a download succeeds.
- **Versions** (`main/find.ts`, `Versions`):
  - A CLI's `--version`, its output and error streams together, is read once per file: by its real path, size, modification time and inode. A file that changes is read anew, and one whose version could not be read is asked again after a minute.
  - `main/version.ts` orders versions as semantic versioning does.
- **The copies** (`main/copies.ts`, `Copies`):
  - They live in `providers/<provider>/<version>/` in the app's data folder. A copy appears under its version's name only once it is whole, renamed from a staging folder in the same folder.
  - A copy runs only while the folders on the way are the user's own, are not links, and only the user may write to them, and while its binary is a file that only the user may change.
  - Each copy is marked when it runs. Copies no build has run for a week go, as do the partial ones a download left.
- **Downloads** (`main/download.ts`, `downloadBuild`):
  - The pin's tarball is streamed through the app module's fetch, Electron's `net.fetch`, and hashed as it arrives. A download fails after a minute without a byte.
  - Only a tarball that matches the pin's integrity is unpacked, with macOS's own `/usr/bin/tar`, taking the pin's folder alone. The binary comes out of brotli where the pin says so, and is left for the user alone to run.
  - Failures are a `DownloadError` naming the `DownloadProblem`: `network`, `checksum`, `unpack` or `folder`.
- **The model** (`shared/installs.ts`):
  - `InstallView`: what runs, the source and version, or nothing; the CLI the app passed over and why; the pinned version; a download's progress; and the last download's problem.
  - `updatePending`: true where the app runs a copy of its own at a version other than the pinned one.
- **Test builds** (`main/builds-fake.ts`): a tarball laid out as npm's are, its integrity, and a download server of the tests' own.

## Not responsible for

- **What a provider's CLI is:** its name, oldest version, version output and pin belong to its adapter (src/providers/), and the pins come from `scripts/provider-pins.mjs`.
- **What PATH and fetch are used:** the app module gives them. It also reads the switches with which tests replace the folders and the pins (`--provider-path`, `--provider-pins`).
- **Showing it:** the accounts module shows the views in the Accounts panel and the session pages' notes.
- **Signing in:** a sign-in runs the provider's own command from the binary that `prepare` gives.
- **The user's own CLIs:** the app never installs or updates them, never puts its copies on the PATH, and never runs them in tests.

## Interface

- **For the provider adapters:** `Pin`, `InstallSpec`, `Binary`, `ProviderInstall` and `NotInstalledError` from `main/install.ts`, and the types in `shared/installs.ts`.
- **For the accounts module:** `ProviderInstall` from `main/install.ts`, and the types and `updatePending` in `shared/installs.ts`.
- **For the app module:** `createInstalls` and `Installs` from `main/installs.ts`, and `pathFolders` from `main/find.ts`.

## Dependencies

- It uses the sessions module's model (`ProviderId` from `src/sessions/shared/`) and Node.js built-ins alone. The rule `installs-only-to-sessions-model` in `.dependency-cruiser.js` enforces this.
- The app module imports it. The provider adapters and the accounts module import only `main/install.ts` and `shared/`.

## Invariants

- Nothing runs from a download that was not whole and checked against its pin, and no copy runs from a folder or file that someone else could have changed.
- Every copy is the build of a pin. The app keeps no credentials and reads nothing of the providers' homes here (invariant 9).
- The choosing, versions, copies and downloads have unit tests: `main/installs.test.ts`, `main/find.test.ts`, `main/version.test.ts`, `main/copies.test.ts` and `main/download.test.ts`. These run fake CLIs and a local server. `tests/contracts/provider-pins.test.ts` keeps each adapter's pin equal to the lockfile's.
