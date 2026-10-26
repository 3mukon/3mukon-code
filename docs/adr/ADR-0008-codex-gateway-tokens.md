---
id: ADR-0008
type: adr
title: Pass a Codex gateway file's settings to Codex, token included
status: accepted
visibility: public
date: 2026-10-26
summary: Provider credentials stay in the providers' own settings and the app never stores, logs or shows a key or token, with one exception to reading and passing them: the main process reads a selected Codex gateway file and passes its settings to Codex, including a token the file holds; refusing such files and letting Codex read them as profiles were rejected
scope: ["src/**"]
tags: []
supersedes: [ADR-0001]
superseded_by:
---

## Context

ADR-0001 extended invariant 9 to every provider credential, gateway tokens included: the app never reads, stores or transmits one, and providers and gateways are configured in the providers' own tools and settings. Gateways are files in each provider's own folder, one per gateway. Claude Code reads its gateway file itself when the app passes the file's path to the Agent SDK. Codex loads its own profile files only from `$CODEX_HOME/<name>.config.toml`, selected by name with `--profile`, so a gateway file in `$CODEX_HOME/gateways/` reaches Codex only through the app, which reads the file and passes its settings with the thread. Such a file may hold its token in `experimental_bearer_token`, and under ADR-0001 the app had to refuse it. On 2026-10-26 the maintainer decided that these files should work.

## Options

- Pass the settings, token included, in memory (chosen): every Codex gateway file works as written and can be chosen for each thread; a token passes through the app's main process on its way to Codex.
- Keep ADR-0001 and refuse a Codex gateway file that holds a token: no token ever reaches the app, but such files fail until their keys move to Codex's `auth.command` or `env_key`.
- Let Codex read each file itself, linked into `$CODEX_HOME` as a profile and selected with `--profile`: no token reaches the app, but the app writes into Codex's folder, runs one app-server for each gateway in use and depends on the app-server honouring `--profile`, which is unverified.

## Decision

Providers and gateways are still signed in and configured through the providers' own tools and settings, and the app keeps no secret storage. The app and its remote host components never store, log or show a provider API key or token, and never send one to the renderer. They read or transmit one in a single case: when a Codex gateway file is selected, the main process reads it and passes its settings to Codex for that thread, including a token the file holds, and reads the file again whenever it needs the settings again rather than keeping a copy. Claude Code gateway files still reach Claude Code by path, unopened. Invariant 9 in `docs/architecture.md` and `AGENTS.md` changes to match.

## Consequences

- Easier: every Codex gateway file works as written, and each thread can use a different gateway.
- Harder: a token passes through the main process, so errors, logs and messages to the renderer must never carry a Codex gateway file's settings.
- Must stay true: only the main process reads a Codex gateway file, and only to pass its settings to Codex. The app names no credential setting in its code, so `scripts/checks/no-provider-keys.sh` keeps applying unchanged. Credentials kept in Codex's `auth.command` or `env_key` keep a token out of the app altogether.

## Revisit when

Codex can load a profile file from another folder, or select a profile for each thread, so that it reads gateway files itself.
