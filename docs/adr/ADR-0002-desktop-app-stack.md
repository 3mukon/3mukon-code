---
id: ADR-0002
type: adr
title: Build the desktop app with Electron and TypeScript
status: accepted
visibility: public
date: 2026-10-23
summary: Electron with TypeScript, because it keeps every provider integration, the Claude Agent SDK included, in one process and one language and reuses the most code; a SwiftUI app with a TypeScript provider process, an all-Swift app and Tauri were rejected
scope: ["**"]
tags: []
supersedes: []
superseded_by:
---

## Context

- The desktop app supports macOS only (invariant 8). Components that run on remote hosts may run on Linux.
- The first version drives three providers, each integrated in a different way:
  - Claude Code: through the Claude Agent SDK, which exists for TypeScript and Python and runs the Claude Code binary underneath. For other languages, Anthropic documents running the CLI as a subprocess in headless mode (`claude -p` with JSON output).
  - Codex: through the Codex CLI's `app-server` mode, JSON-RPC over stdio.
  - Grok Build: through the Agent Client Protocol (ACP), JSON-RPC over stdio.
  Only the Claude Code integration depends on the language; the other two are language-neutral protocols.
- The first version shows sessions, live activity, approvals and questions, and file diffs. Rendering agent output means Markdown with math, syntax-highlighted code and diffs.
- The UI ships in English and Simplified Chinese.
- Coordination between agents of different providers runs where the provider integrations run, keeps its state across restarts, and must leave room for agents on remote hosts later.
- Existing TypeScript code for these provider integrations and for the rendering components can be ported.

## Options

| | A. Electron and TypeScript | B. SwiftUI app with a TypeScript provider process | C. All Swift |
|---|---|---|---|
| Provider integration | All three in one TypeScript process; the Claude Agent SDK in-process | All three in a bundled TypeScript process (Node.js, or a single-file executable) that the app talks to over a local protocol | Codex and ACP clients written in Swift; Claude Code through its headless CLI protocol, without the SDK |
| UI | React, with mature Markdown, math, code and diff rendering | Native SwiftUI; rich rendering needs native libraries or embedded web views | Native SwiftUI, as in B |
| Languages | One language and one test stack | Two languages, two test stacks, and a local protocol between them to version and test | One language |
| Reuse of existing TypeScript | High: integrations and renderers | Integrations only; the UI is new | None |
| Footprint | Large: Chromium and Node.js in the app bundle, high memory baseline | A native app plus a bundled JavaScript runtime | Smallest |
| macOS integration | Electron's APIs, native add-ons for the rest | Full native: menus, notifications, App Intents, accessibility | Full native |
| Remote hosts later | The TypeScript core can run on Linux hosts | The provider process is the natural remote core, and its local protocol is the boundary remote setups need | Swift on Linux is possible but uncommon for this kind of service |
| Toolchain | Node.js, pnpm, electron-builder | Xcode and Node.js tooling | Xcode |
| Main risks | App size and memory; a non-native look; native modules must be rebuilt against each Electron release's Node.js ABI | An extra process and protocol from the first version on | Owning Claude Code's headless protocol, permission prompts and session handling, which the SDK provides |

D. Tauri (Rust with the system web view) was also considered and is not recommended. The provider integrations would still need a TypeScript process, so the app would carry three runtimes (Rust, the web view and Node.js) and work around web view differences.

## Decision

A, Electron and TypeScript, chosen by the maintainer on 2026-10-23. Claude Code is integrated through the Claude Agent SDK.

A keeps all three provider integrations, the Claude Agent SDK included, in one language and one process; it carries over the most existing code; and it renders agent output with mature web libraries.

B was rejected because it adds a second language and a local protocol from the first version on, and the UI would be written from scratch. C was rejected because it gives up the official SDK for Claude Code and all reuse, and D because the app would carry three runtimes.

## Consequences

- Easier: one toolchain and one test runner; provider SDKs and protocol clients run in-process; integrations and renderers can be ported; when remote setups return, the TypeScript provider code can run on Linux hosts.
- Harder: app size and memory use; following macOS conventions takes deliberate design work; native modules need a rebuild for each Electron release.
- Must stay true: packaging targets macOS only (invariant 8); the renderer gets no direct access to Node.js or the file system, only a typed bridge; the change that adds the first code wires typecheck, lint and tests into `scripts/checks/code.sh`.

## Revisit when

A provider ships an official Swift SDK, footprint or a native look becomes a requirement, or Electron no longer suits a macOS-only app.
