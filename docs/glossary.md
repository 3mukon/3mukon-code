---
id: DOC-glossary
type: doc
title: Glossary
status: current
visibility: public
date: 2026-10-26
summary: This project's terms and the synonyms to avoid
scope: []
tags: []
---

One name per concept: naming and search follow the Term column, and Avoid lists synonyms not to use.

| Term | Meaning | Avoid |
|---|---|---|
| desktop app | The macOS application this repository builds | client, frontend |
| maintainer | The person who owns this repository's hard base and approves changes to it | owner, admin |
| provider | A coding-agent tool the app drives through its own SDK or CLI: Claude Code, Codex or Grok Build | backend, engine |
| permission mode | What a session asks the user before acting: auto or yolo (ADR-0006) | approval mode |
| remote host | A machine other than the user's Mac on which agent sessions or their supporting services run; it may run Linux | server (for this meaning), remote machine |
| session | One conversation with one provider's agent in one working directory | chat, thread, conversation |
| session page | A panel that chooses a session's settings and starts the session with its first message, and then shows it | new-session dialog, draft |
| sandbox level | How far a session's commands may reach, set apart from the permission mode: read-only, workspace-write or full access | sandbox mode, sandbox profile (except as a provider's own terms) |
| toolset | The app's own MCP tools, named 3mukon-code, which it serves to each session's provider process (ADR-0012) | MCP server (for this meaning), plugin |
| workspace | A folder on this Mac that the user added to the app's Workspaces list, with their answer to whether they trust its files | project, root (for this meaning) |
| bridge | The typed interface the app module's preload script gives the page, its only way to the main process | IPC API, preload API |
| panel | One part of the main area's layout, showing a session, a session page, a file, a terminal, or one of the app's own panels: the archived sessions, the accounts or the settings | pane, tab, view |
| gateway | A provider's settings file that the user picks for a session to run it through another endpoint or account: a Claude Code settings file or a Codex profile in the provider's gateways folder (ADR-0028) | proxy, profile (for this meaning) |
| usage window | One span of a subscription's usage limits, such as five hours or a week, with the share used and when it resets (ADR-0017) | quota, window (alone, for this meaning) |
| child session | A session another session started with the toolset, which works in its parent's folder, shows beneath it in the Sessions list and starts no sessions of its own (ADR-0036) | subagent (the providers' own), teammate, worker |
| inbox | Where a session's messages from other sessions wait, each with a summary that reaches its agent by itself and a body it reads through a tool (ADR-0036) | queue, mailbox |
| notice | What tells an agent of a change it did not make itself, beside the user's next message or with a tool's result: of a presentation's state (ADR-0026) or of new messages (ADR-0036) | notification (for this meaning) |
