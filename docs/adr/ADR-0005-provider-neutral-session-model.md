---
id: ADR-0005
type: adr
title: Model every session as one provider-neutral event stream
status: accepted
visibility: public
date: 2026-10-25
summary: Each provider adapter maps its protocol onto one internal interface, a session that reports serializable events and takes answers to approvals and questions, using ACP's tool vocabulary, unified diffs and per-request approval options; adopting ACP itself as the internal model and building a UI per provider were rejected
scope: ["src/sessions/**", "src/providers/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

The first version drives Claude Code through the Claude Agent SDK, Codex through `codex app-server` and Grok Build through ACP agent mode (ADR-0002, ADR-0003). Live activity, approvals and questions, task rows, diffs and history must work the same for all three.

The protocols overlap. All three stream messages and tool calls; keep a task list (Claude's TodoWrite and task tools, Codex's turn plan, ACP's plan); ask before acting; can ask the user questions (Claude's AskUserQuestion tool, Codex's `request_user_input`, ACP's elicitation); and list and resume past sessions. They differ in detail: Claude and Codex can remember an approval for the rest of the session, while ACP offers whatever options the agent lists for each request; Codex reports file changes as unified diffs, Claude as edit fragments and ACP as old and new text; and only ACP replays a loaded session's history to the client.

## Options

- One internal interface with its own event model, which each adapter translates into (chosen).
- ACP as the internal model, with Claude Code and Codex translated into ACP. ACP is an existing schema, but it is built for editors and carries file-system and terminal methods the app does not need; its elicitation and session listing are still unstable; and it has no notion of approving for the rest of the session. The app would extend it anyway, and would follow its changes.
- A UI per provider, each over its raw protocol. This needs no translation layer, but every feature would be built three times and the three UIs would drift apart.

## Decision

Sessions are modelled once, in the sessions module (DOC-mod-sessions). A `Provider` starts, resumes and lists sessions; a `ProviderSession` takes messages, interrupts, answers and mode changes; everything a session reports is a `SessionEvent`. Within that model:

- Tool calls use ACP's tool kinds and statuses, the closest thing to a shared vocabulary.
- File changes travel as unified diffs, into which every protocol's form can be turned.
- Each approval states whether "allow for the session" is available, because providers decide that per request.
- Resuming replays the past through the same events, so that a resumed pane fills like a live one.
- Everything is plain serializable data, so adapters can run in the main process now and move to a separate process later without changing the interface.

## Consequences

- Easier: the UI, the waiting indicator and history are built once; each adapter is tested against the model alone; another provider means one more adapter.
- Harder: provider features the model has no place for, such as Codex's command-policy amendments or Claude's background tasks, stay hidden until the model grows. Each adapter carries the translation, including building diffs and replaying Claude's and Codex's history.
- Must stay true: protocol types never leak into events; every request ends with `request-resolved`; the model grows only by changes that every adapter can honor, or that are optional.

## Revisit when

A provider ships a capability the app needs that the model cannot express, or ACP's session listing and elicitation become stable and the other providers adopt ACP natively.
