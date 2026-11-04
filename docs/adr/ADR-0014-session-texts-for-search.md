---
id: ADR-0014
type: adr
title: Keep the text of each session's messages in the app's data, for searching
status: accepted
visibility: public
date: 2026-11-03
summary: The app keeps the text of each session's messages, the user's and the agent's, in a file of its own in the app's data, written as turns end, sessions close and histories are read and caught up in the background for older sessions, so that the lists search by conversation at once; reading every history at each search, searching only the histories already read, a SQLite full-text index and reading the providers' own files were rejected
scope: ["src/sessions/main/**", "src/sessions/shared/**", "src/app/main/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

The Sessions list and the archived sessions are to be searchable by what was said in each session as well as by its title. A session's conversation lives in its provider's own store, and the app reads it only through the provider's adapter, without resuming the session: Claude Code's from its transcript through the Agent SDK, Codex's from a short-lived app-server, and Grok Build's from a short-lived process that loads the session. A read takes milliseconds for Claude Code and a second or more for Codex and Grok Build, and the lists hold up to a thousand sessions besides the archived ones. The app reads and writes only its own data, the workspaces' files and the files dropped on it.

## Options

- A copy in the app's data (chosen): each session's messages as text in a file of the app's own, kept as the app sees them and caught up once for sessions read before; a search scans those files, which takes tens of milliseconds for the lists' sessions, and finds every session the copy holds.
- Reading the histories at each search: nothing copied, but each search takes seconds for Claude Code's sessions and starts a process per Codex or Grok Build session, minutes for a full list.
- Searching only the histories read in this run: at once and with nothing copied, but it misses every session not yet opened or read ahead, which is most of them.
- A SQLite full-text index, through better-sqlite3 or Node's own SQLite: ranked and fast at any size, but a native module to bundle and sign, or an API still experimental, with a schema and its migrations, for what a scan of plain files does fast enough.
- Reading the providers' own files directly, Claude Code's transcripts and Codex's rollout files: no processes to start, but the app would depend on the providers' private formats and read outside its own data, and Grok Build's store has no documented format.

## Decision

The sessions module's host keeps, through `SessionTexts`, the text of each session's messages, the user's and the agent's, in `session-texts/<id>.txt` in the app's data, readable by the user alone. It writes a session's text as its history is read, as a turn of it ends and as it closes. Shortly after the app opens, it catches up: it reads, one at a time and the most recently active first, the history of every session the records keep that has no text, as a history read does now, keeping nothing of it in memory but its text; a session read otherwise meanwhile is skipped, one whose history cannot be read is tried again in the next run, and texts of sessions the records no longer keep are deleted. A search takes every word of the query, ignoring case, and matches a session whose title and text together hold them all, with the passage of the text where the first word appears; a session open in this run is searched in its current state rather than its file. It also says how many of the sessions searched have no text yet.

## Consequences

- Easier: searching by conversation is instant, needs no provider at the time, and works for sessions of every provider alike.
- Harder: a second copy of the conversations' text stays on disk, which must leave with its session; the first catch-up starts a short-lived Codex or Grok Build process per session of theirs; a session's file lags its running turns until a turn ends, which its state in memory covers while the app runs.
- Must stay true: the copy holds the messages' text alone, in the app's own data and readable by the user alone; a session removed from the lists, or no longer kept by the records, loses it; the catch-up reads one history at a time and never resumes a session.

## Revisit when

The texts grow beyond what a scan per search handles within about a hundred milliseconds, or a provider offers a search of its own sessions.
