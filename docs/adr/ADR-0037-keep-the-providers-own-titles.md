---
id: ADR-0037
type: adr
title: Keep the title each provider gives a session, and write one only for a session its provider leaves untitled
status: accepted
visibility: public
date: 2026-11-23
summary: Claude Code and Grok Build title their sessions on their own, so the app keeps any title a provider reports, its own or the user's, and asks the session's provider for a title of its own, as ADR-0035 describes, only for a session that has run for a while without one, as every Codex session does; replacing the providers' own titles with the app's, and telling a provider's own title from the user's, were rejected
scope: ["src/sessions/**", "src/providers/**"]
tags: []
supersedes: [ADR-0035]
superseded_by:
---

## Context

ADR-0035 decided that the host asks each session's own provider for a title once the session has run for a while, with the session's model at low effort, and that the title replaces the first message or a title the provider wrote on its own, Grok Build's, while one the user gave stands. It took Claude Code to write no title of its own through the Agent SDK.

A run of the app on Claude Code through Agent SDK 0.3.318 showed otherwise: after the first turn, Claude Code had written `ai-title` entries to the session's transcript, a title it generates once from the first prompt with a request of its own, and the SDK's `getSessionInfo` reports `customTitle` as the user's custom title or else that AI title. Grok Build titles its sessions too. Codex's app-server offers no way to have a thread titled: a client names one with `thread/name/set`.

The maintainer decided that where a provider generates session titles natively, the app reuses that capability.

## Options

- Keep any title a provider reports, its own or the user's, and write one only for a session that has run for a while without one (chosen): the providers that title their sessions keep doing so, at no further cost, a title the user gives in a provider's own tools always stands, and every Codex session, or one whose provider failed to title it, still gets a title.
- Replace the providers' own titles with the app's, as ADR-0035 did for Grok Build: it spends a request where the provider has already titled the session, and since Claude Code and Grok Build report their own titles and the user's alike, a title the user gave before the app's would be replaced.
- Tell a provider's own title from the user's, by Claude Code's transcripts or by when a title comes: it couples the app to a provider's storage format, or guesses.

## Decision

The host shows the title a provider reports for a session, its own, the user's or the app's as the provider took it, then the title the app wrote, then the first message. At the end of a turn, once the session has run for a while, it asks the session's provider for a title (`Provider.writeTitle`) only where the provider has reported none, and drops one that comes once the provider has; everything else ADR-0035 decided about that request stands: when it is asked, with what model, effort and prompt, how its reply becomes a title, how often it is tried, and that the title is kept with the session and given back to the provider (`ProviderSession.setTitle`). No provider is marked as titling on its own.

## Consequences

- Claude Code and Grok Build sessions show their provider's own title, from the first prompt, as soon as the provider reports it; Codex sessions show their first message until the app's title, once they have run for a while.
- Claude Code's and Grok Build's adapters still write a title for a session their provider leaves untitled, such as one whose title request failed.
- A session's title is written by the app's request only where its provider gives none, so a title costs no request for Claude Code and Grok Build sessions in the usual case.
- A title that arrives from the provider after the app has asked for one wins, and the app's is dropped.

## Revisit when

- Codex offers a way to have a thread titled, or a provider stops titling its sessions.
- The user wants titles written again as sessions go on.
