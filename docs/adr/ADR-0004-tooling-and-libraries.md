---
id: ADR-0004
type: adr
title: Build on Electron 44 and TypeScript 6 with electron-vite, React, Tailwind and i18next
status: proposed
visibility: public
date: 2026-10-24
summary: The app uses Electron 44, TypeScript 6, pnpm 12, electron-vite on Vite 8, electron-builder for macOS arm64, React with zustand, Tailwind, i18next, vitest and Playwright, ESLint and Prettier, and dependency-cruiser, with the provider packages pinned and bundled
scope: ["**"]
tags: []
supersedes: []
superseded_by:
---

## Context

ADR-0002 chose Electron and TypeScript, and ADR-0003 the provider protocols; the tools and libraries inside that stack were still open. The constraints: macOS arm64 only (invariant 8); a UI in English and Simplified Chinese that follows a reference design built on colour tokens; existing renderer code to port is written in React with Tailwind; typescript-eslint 8.72 supports TypeScript below 6.1 only. Versions below were current on 2026-10-24.

## Options

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
| Provider packages | Pinned and bundled: `@anthropic-ai/claude-agent-sdk` 0.3.310, `@openai/codex` 0.164.0, `@xai-official/grok` 1.0.70, `@agentclientprotocol/sdk` 2.0.2 | The CLIs a user has installed | Pinned binaries make protocol types and behaviour reproducible (ADR-0003) |
| Signing | An ad-hoc signed local build, installed into `/Applications` | Developer ID signing and notarization | The app is built for local use, not distributed as a signed download |

## Decision

Everything in the Chosen column.

## Consequences

- Easier: one build config for main, preload and renderer; the existing renderers port without a framework change; both UI languages stay complete because a check compares the catalogs.
- Harder: Electron's size and memory use; TypeScript 7's faster compiler waits until typescript-eslint supports it; native-module rebuilds stay avoided only while no native modules are added, so durable state should use `node:sqlite`.
- Must stay true: the electron-builder config lists macOS arm64 targets only; every UI string exists in both catalogs; provider packages are pinned to exact versions and upgraded deliberately, with Codex's protocol types regenerated on each upgrade; the app is ad-hoc signed and installed locally.

## Revisit when

typescript-eslint supports TypeScript 7; Electron 44 leaves the supported window, when Electron 47 ships; the app needs durable state; or the app is to be distributed as a signed download.
