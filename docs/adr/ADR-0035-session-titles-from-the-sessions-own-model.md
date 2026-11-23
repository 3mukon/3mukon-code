---
id: ADR-0035
type: adr
title: Title each session once it has run for a while, in a request of its own provider's with the session's model at low effort
status: superseded
visibility: public
date: 2026-11-23
summary: Once a session's turns have run a minute in all or three turns have ended, the host asks the session's own provider for a title from the conversation so far, with the model the session runs at low effort, in a short-lived request that runs no tools and leaves no session behind, replaces the first message or a title the provider wrote on its own with it, keeps it, and gives it back to the provider; a title from the session's own process, Claude Code's automatic titles, one model for every provider and a title on the first message were rejected
scope: ["src/sessions/**", "src/providers/**"]
tags: []
supersedes: []
superseded_by: ADR-0037
---

## Context

A session showed its first message, on one line, as its title until its provider titled it. Codex never titles a thread by itself; Claude Code, driven through the Agent SDK, writes no title of its own, so the title it reports is the first prompt; Grok Build titles its sessions itself. Each provider keeps a title for a session where a client gives one: Codex as the thread's name (`thread/name/set`), Claude Code as the session's custom title (`renameSession`), and Grok Build through an undocumented extension request, `_x.ai/session/rename`, which takes `{ sessionId, title }` and answers `{ success: true }`, as a short-lived Grok Build 1.0.70 reported without any prompt to the model.

A title should say what a session is about, which its first message often does not, and should cost little of the user's usage. The model a session runs is one the user chose for it and has access to through the session's sign-in and gateway.

## Options

- Who writes the title:
  - A request of the session's own provider, through the session's gateway and with the model the session runs, beside the session (chosen): every provider and gateway that runs a session can title it, on the same sign-in, and the title costs a little of the usage the session already uses.
  - The session's own process, asked for a title in a turn of its own: the request and its reply would join the session's conversation and history, and the agent's context and tools would shape the title.
  - One provider and model for every session, such as the cheapest of one provider: a session on another provider would spend another provider's usage, and the provider might not be signed in.
  - Claude Code's own automatic titles: the SDK writes none for a session it drives, and Codex and Grok Build would still need a request of the app's.
- How the request runs, for each provider:
  - Claude Code: a Claude Code of its own in a throwaway folder that answers one message, with the session's model and effort, a system prompt of the app's in place of Claude Code's, no tools, no MCP servers, one turn and no transcript kept, through the gateway's settings file or else the user's own settings with their hooks off, as the models' probe reads them (chosen).
  - Codex: an ephemeral thread, which keeps no rollout, in a short-lived app-server in a throwaway folder, read-only and never asking, through the gateway's settings where the session has a gateway; a turn whose thread starts any tool fails, and closing the app-server stops the tool (chosen).
  - Grok Build: a new session of a short-lived, read-only process in a throwaway folder, with the model and effort set through ACP's configuration options, which is deleted from Grok's history with `_x.ai/session/delete` once it has answered or failed; Grok's agent mode keeps its built-in tools whatever its command line says, so a title whose agent starts a tool call is cancelled and fails (chosen). Grok's headless mode was rejected, as for sessions (ADR-0003), and to keep one way of starting Grok.
- When:
  - At the end of the first turn that ends once the session's turns have run for a minute in all, or at the end of its third turn, whichever comes first (chosen): by then the conversation says what the session is about, and a quick exchange that never gets there keeps its first message.
  - At the first message, or the first turn's end: a short opening says little about a session that goes on.
  - Again as the session changes course: a title that keeps changing is hard to find again, and each costs usage.
- What it replaces:
  - The first message, and a title the provider wrote on its own, as Grok's are, while a title the user gave the session in the provider's own tools stands (chosen). Codex and Claude Code keep only titles a client or the user gave, so a title they report that the app did not write is the user's; Grok Build reports its own titles and the user's alike, so a title Grok reports stays behind a written one.
- What becomes of it: the app keeps the written title with the session's record and gives it back to the provider where the provider keeps titles (chosen), so that the provider's own tools and a later run show it; a failed write-back leaves the app's title standing.

## Decision

The host counts how long a session's turns run and how many end in this run, and at the end of a turn, once the session has run for a while, asks the session's provider (`Provider.writeTitle`) for a title from the conversation so far: the user's and the agent's messages without the agent's thinking, the first messages and the latest where the conversation is long, with instructions to answer with a title alone, in the conversation's language and within 60 characters, and to treat the conversation as data. The request carries the session's gateway, the model the session runs and the low effort the model takes (`titleEffort`: low, or else the model's lowest level, or none for a model without levels). The host takes the reply's first line without quotation marks, emphasis, heading marks, a label or a full stop, cut at a word within 60 characters, keeps it with the session (`titled` in the records), shows it in place of the first message and gives it to the provider (`ProviderSession.setTitle`). A request that fails or gives nothing usable is tried again at the end of the next turn, three times at most in a run; a title that comes once the session has closed or left the lists, or once the user has given one, is dropped; a provider marks with `titlesOnItsOwn` that the titles it reports may be its own.

## Consequences

- Every session gets a title that says what it is about, on every provider and gateway, at the cost of one short request at low effort.
- The requests leave nothing in the providers' histories: Claude Code keeps no transcript, Codex no rollout, and Grok's session is deleted. Grok's rename and delete requests are undocumented, so a Grok Build upgrade must be checked against them, as its other extension requests are.
- A Grok session's title written by the app stays even as Grok writes titles of its own later, and a title the user gives a Grok session in Grok's own tools cannot be told from Grok's.
- A title is written once; renaming a session in the app is a later change.

## Revisit when

- Claude Code's SDK, Codex or Grok Build titles sessions themselves in a way the app can rely on.
- The user wants titles written again as sessions go on, or a setting to turn them off.
