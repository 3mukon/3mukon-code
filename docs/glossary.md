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
| sandbox level | How far a session's commands may reach, set apart from the permission mode: read-only, workspace-write or full access | sandbox mode, sandbox profile (except as a provider's own terms) |
| toolset | The app's own MCP tools, named 3mukon-code, which it serves to each session's provider process (ADR-0009) | MCP server (for this meaning), plugin |
| workspace | A folder on this Mac that the user added to the app's Workspaces list, with their answer to whether they trust its files | project, root (for this meaning) |
| bridge | The typed interface the app module's preload script gives the page, its only way to the main process | IPC API, preload API |
