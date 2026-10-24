---
id: ADR-0003
type: adr
title: Drive Codex through app-server and Grok Build through ACP agent mode
status: accepted
visibility: public
date: 2026-10-24
summary: Codex runs as `codex app-server` and Grok Build as `grok agent stdio`, because only these interfaces let the app answer approvals and questions while a turn runs; the Codex SDK, `codex exec`, `codex mcp-server`, Grok Build's headless mode and third-party ACP adapters were rejected
scope: ["**"]
tags: []
supersedes: []
superseded_by:
---

## Context

- The first version must answer approvals and questions while a turn runs, resume sessions and stream live activity for every provider. Claude Code is integrated through the Claude Agent SDK (ADR-0002).
- Codex 0.164 offers `codex app-server` (JSON-RPC over stdio, marked experimental), the TypeScript SDK `@openai/codex-sdk` (it spawns the CLI and exchanges JSONL events), `codex exec --json`, and `codex mcp-server`.
- Grok Build offers a headless mode (`grok -p` with streaming JSON output) and an agent mode that speaks the Agent Client Protocol (ACP) over stdio (`grok agent stdio`) or WebSocket (`grok agent serve`), with Grok-specific `x.ai/*` extension methods. Its documentation names agent mode as the path for IDEs, SDKs and custom apps.

## Options

- Codex, `app-server` (chosen): approvals for commands, file changes and permissions, user questions and MCP elicitations arrive as requests the client answers; threads can be started, resumed, forked and listed. The CLI generates TypeScript bindings and a JSON Schema for its protocol (`codex app-server generate-ts`, `generate-json-schema`).
- Codex, `@openai/codex-sdk`: simpler threads and streaming, but its documentation describes no way for the host to answer approval requests; permissions are fixed up front.
- Codex, `codex exec --json` or `codex mcp-server`: one-shot or tool-shaped, with no interactive approvals or session control.
- Grok Build, ACP agent mode over stdio (chosen): sessions can be created, loaded and resumed; permission prompts go to the client unless the session always approves; the `x.ai/*` extensions add fork, prompt history, rewind and compaction.
- Grok Build, headless mode: only preset permission modes and allow or deny rules; it cannot ask the client.
- Third-party ACP adapters for Codex and Claude Code, so that one protocol serves every provider: an extra dependency between the app and each provider that can lag behind provider features, and that does not expose every native capability.

## Decision

Codex runs as `codex app-server` over stdio, with its protocol types generated from the bundled Codex version. Grok Build runs as `grok agent stdio` and is spoken to through the ACP TypeScript SDK, using the `x.ai/*` extensions where they expose native capabilities. Claude Code stays on the Claude Agent SDK (ADR-0002).

## Consequences

- The app has one integration adapter per provider protocol, behind one internal session interface.
- Codex's protocol types are regenerated whenever the bundled Codex version changes, so protocol changes surface as type errors. The protocol is experimental, so each Codex upgrade is tested before it ships.
- The ACP TypeScript SDK is at 2.x; code written against 1.x needs updating.
- Grok Build's own `grok agent serve` (WebSocket with a shared secret) is the natural transport for Grok Build when remote setups return.
- Sessions start in each provider's ask mode, so approvals reach the user; an always-approve mode is a per-session choice the user makes.

## Revisit when

Codex or xAI ships an SDK that lets the host answer approvals, or `app-server` changes incompatibly.
