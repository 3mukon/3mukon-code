---
id: ADR-0039
type: adr
title: Run each provider from the CLI the user installed, or else from a copy the app downloads at sign-in, and keep ADR-0004's other tooling
status: accepted
visibility: public
date: 2026-11-25
summary: The app runs each provider from the first CLI of its name on the PATH it runs providers with, where that CLI is at least the oldest version its adapter drives, and otherwise from its own copy of the provider's official build, downloaded into the app's data at sign-in at the version and checksum the app pins, so that users update their providers themselves and the app no longer carries the providers' binaries; ADR-0004's other choices stand, restated here
scope: ["**"]
tags: []
supersedes: [ADR-0004]
superseded_by:
---

## Context

ADR-0004 pinned and bundled the provider packages. It rejected running the CLIs a user has installed, so that the protocol types and behaviour the adapters are written against stay reproducible (ADR-0003). As a result, the packaged app carries three binaries:

- Claude Code's, about 364 MB, unpacked.
- Codex's with the tools beside it, about 377 MB, unpacked.
- Grok Build's, about 51 MB, compressed. Its adapter unpacks it into the app's data once per version.

This has two costs:

- **Updates:** users who keep a provider's CLI up to date, with its own installer, Homebrew or npm, still run the app's older copy. They cannot take a fix or a new model before the app's next build.
- **Redistribution:** a CLI whose terms grant no right to redistribute it cannot be bundled at all. Google's Antigravity CLI, `agy`, is one.

What the providers offer, as read on 2026-11-25:

- **Versions:** each CLI prints its version with `--version`: `2.1.330 (Claude Code)`, `codex-cli 0.171.0`, `grok 1.0.92 (…)`.
- **npm builds:** the npm registry serves each platform package the app bundles as a tarball with a sha512 integrity, the same one `pnpm-lock.yaml` records. The tarballs are 157 MB for Claude Code, 150 MB for Codex and 51 MB for Grok Build.
- **Claude Code's version:** the Claude Agent SDK names the Claude Code version it brings, in its package's `claudeCodeVersion`.
- **agy:** Google publishes `agy` builds at versioned addresses on its public bucket. Its installer's update manifest gives the SHA-512 of the latest build. Earlier builds stay downloadable, though nothing promises they will.
- **PATH:** the packaged app runs the providers with the login shell's PATH (ADR-0019).

## Options

| Question | Chosen | Rejected | Why |
|---|---|---|---|
| Which binary runs | The user's CLI: the first executable named `claude`, `codex` or `grok` in the absolute folders of the PATH the app runs providers with, when it is at or above its adapter's oldest version. Otherwise the app's own copy. With neither, the provider shows as not installed | The app's own pinned copy always (ADR-0004); the app's copy first, with the user's as a fallback; a setting per provider; looking in install folders that the PATH lacks | Users update their CLIs themselves and expect those to run. A terminal runs the first on the PATH. A setting is a choice nobody asked to make |
| When it is chosen | Anew for every process the app starts for a provider: a session, a model list, an account read, a sign-in. A running session keeps the binary it started with | Once, as the app starts | A CLI the user installs or updates takes effect without restarting the app |
| How old a user's CLI may be | Each adapter states the oldest version it drives. At first that is the version it pins; for Claude Code it is the SDK's `claudeCodeVersion`. A CLI whose `--version` is older, or cannot be read, gives way to the app's copy, and Accounts says why. A newer CLI runs as it is | No check; also refusing versions newer than the pin | An older CLI may lack what the adapter uses, and would fail in ways that are hard to read. A newer one is the user's choice |
| Where the app's copy comes from | The provider's official build for macOS arm64, at the version and checksum the app's build pins. For npm, the registry's tarball of the platform package the lockfile pins, checked against the lockfile's sha512 integrity. For a provider published outside npm, the maker's versioned download address and the SHA-512 the maker gave for that build | The providers' installers (`npm install -g`, the makers' install scripts); the latest release; a copy hosted for the app | Installers put CLIs on the user's PATH and change shell profiles. The adapters are written against the pin. Redistributing a build may be outside its terms |
| When it downloads | When the user signs in through the app to a provider that has no copy that runs. And once a build pins a newer version than the app's copy, at the next sign-in or session with that provider, before its process starts. Until then, or if that download fails, the old copy runs while it is at or above the oldest version | As the app starts, or in the background | Downloads of 50 to 160 MB that nobody asked for |
| Where copies live | `providers/<provider>/<version>/` in the app's data folder, which must be the user's own and private. A download is hashed as it arrives, unpacked with macOS's `tar` only once its checksum matches, and renamed into place whole. Each copy is marked when it runs and removed after a week unused, as Grok Build's unpacked binary is now | A cache outside the app's data; keeping every version | Nothing incomplete or unchecked runs. Builds of the app that share its data folder each keep their own version |
| What the app carries | The Claude Agent SDK's code, which the main process loads, but none of the providers' binaries. The Codex and Grok Build packages stay pinned in `package.json` as development dependencies, for Codex's protocol types, the tests and the pins | Dropping those packages from `package.json` | The lockfile stays the one record of versions and checksums |
| Updaters | The app's copies run with their providers' own updaters off, where a provider offers a switch | Letting a copy update itself | A copy follows the version its build pins |
| Tests | Only tests replace, at launch, the folders the app looks in for CLIs and the address it downloads from. Smoke and packaged tests point them at copies made from the pinned packages and at a server of their own | Relying on the tests' PATH | The packaged app reads the login shell's PATH, which can hold the developer's CLIs (L-0006, L-0007) |

ADR-0004's other choices stand, restated here as ADR-0004 recorded them on 2026-10-24. `package.json` holds the versions in use.

| Area | Chosen | Rejected | Why |
|---|---|---|---|
| Runtime | Electron 44 (44.9.x: Node 24.22, Chrome 152), moving to 45 after its first patch releases | Electron 45.0.0, released on 2026-10-21 | A major that has had two months of fixes. Both bundle Node 24, whose built-in `node:sqlite` can hold durable state later without native modules |
| Language | TypeScript 6.0, strict | TypeScript 7 | typescript-eslint 8.72 supports TypeScript below 6.1 only |
| Package manager | pnpm 12, pinned with `packageManager` and Corepack | Older pnpm, npm | One lockfile behaves the same on every machine |
| Build | electron-vite 6 on Vite 8 | Electron Forge with its Vite plugin | One config for main, preload and renderer |
| Packaging | electron-builder 26, macOS `dir` and `dmg` targets, arm64 only | Electron Forge makers | macOS-only targets in one file keep invariant 8 checkable |
| UI | React 19 with zustand 5 | Solid, Svelte | The renderer code to port is React, and the state is small |
| Styling | Tailwind 4, with the reference design's colour tokens as CSS variables | Plain CSS modules | The tokens map onto theme variables directly, and the code to port uses Tailwind |
| Markdown and code | react-markdown, remark-gfm, rehype-katex, refractor | Shiki | Light, and used by the code to port |
| Diffs | `diff` 9 with a custom unified view | Monaco's diff editor | Monaco is heavy for reviewing changes |
| Localization | i18next 26 and react-i18next 17; JSON catalogs `en` and `zh-Hans`; a check that both hold the same keys | FormatJS, Lingui | Mature and simple; the check keeps both languages complete |
| Settings storage | A JSON file in the app's data folder (electron-store 12) | SQLite | Only settings and layout are stored; session history stays in the providers' own stores |
| Tests | vitest 5 for units, Playwright 1.64 for Electron smoke tests | Jest | Vite-native; Playwright can drive Electron |
| Lint and format | ESLint 10 with typescript-eslint 8, Prettier 3 | Biome | Type-aware lint rules |
| Module boundaries | dependency-cruiser 18, run from `scripts/checks/code.sh` | eslint-plugin-boundaries | Declared dependency directions must be enforced |
| Signing | An ad-hoc signed local build, installed into `/Applications` | Developer ID signing and notarization | The app is built for local use, not distributed as a signed download |

## Decision

Everything in the Chosen columns:

- The app runs each provider from the user's CLI where one is on the PATH at or above its adapter's oldest version.
- Otherwise it runs the provider from its own copy of the pinned official build, downloaded into its data folder at sign-in.
- It no longer carries the providers' binaries.
- ADR-0004's other choices stand.

## Consequences

- **Easier:**
  - A user takes a provider's fix or new model the day it ships, by updating their CLI.
  - The app is about 790 MB smaller.
  - A provider whose CLI the app may not redistribute can still run, from the user's install or from the maker's own download.
- **Harder:**
  - The adapters meet newer versions than they were written against, and run them as they are.
  - A provider with no CLI of the user's needs a download, and the network, before its first sign-in.
  - Accounts has more to say.
  - A provider published outside npm takes its pin from its maker's manifest, and the maker may remove old builds.
- **Must stay true:**
  - The electron-builder config lists macOS arm64 targets only.
  - Every UI string exists in both catalogs.
  - The app's copies are pinned to exact versions and checksums and upgraded deliberately. Each upgrade regenerates Codex's protocol types and the pins, and decides whether each adapter's oldest version moves.
  - The app never puts its copies on the user's PATH, and never installs or updates the user's CLIs.
  - Tests never run the developer's CLIs.
  - The app is ad-hoc signed and installed locally.

## Revisit when

Reconsider this decision when any of these happens:

- typescript-eslint supports TypeScript 7.
- Electron 44 leaves the supported window, when Electron 47 ships.
- The app needs durable state.
- The app is to be distributed as a signed download.
- A provider stops publishing builds at pinned versions, or its CLI stops reporting its version.
