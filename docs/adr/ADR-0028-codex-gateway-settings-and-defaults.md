---
id: ADR-0028
type: adr
title: Pass a Codex gateway file's settings to Codex, token included, and show only its model and effort
status: accepted
visibility: public
date: 2026-11-18
summary: The main process reads a selected Codex gateway file and passes its settings to Codex, a token included, and never stores, logs or shows a key or token; of the file's settings only its model and effort reach the renderer, as the defaults a thread through the gateway runs, so that the Model setting names what the session runs
scope: ["src/**"]
tags: []
supersedes: [ADR-0008]
superseded_by:
---

## Context

ADR-0001 extended invariant 9 to every provider credential, gateway tokens included. Gateways are files in each provider's own folder, one per gateway. Claude Code reads its gateway file itself when the app passes the file's path to the Agent SDK. Codex loads its own profile files only from `$CODEX_HOME/<name>.config.toml`, selected by name with `--profile`, so a gateway file in `$CODEX_HOME/gateways/` reaches Codex only through the app, which reads the file and passes its settings with the thread. Such a file may hold its token in `experimental_bearer_token`. ADR-0008 decided that these files should work: the main process passes their settings, token included, in memory.

ADR-0008 also said that errors, logs and messages to the renderer must never carry a Codex gateway file's settings. Yet a session's models have offered the file's `model` since gateways came, and a thread through a gateway runs the file's `model` and `model_reasoning_effort` over Codex's own configuration, as probes of Codex 0.166.0's app-server showed. For the Model setting to name the model and the effort a session runs, the models have to show both. Neither is a credential: each names what the thread runs.

This decision replaces ADR-0008 and differs from it only in letting the file's model and effort reach the renderer.

## Options

- What of a Codex gateway file reaches the renderer:
  - Its `model` and `model_reasoning_effort`, as the defaults a thread through the gateway runs, and nothing else (chosen): the Model setting names what the session runs, and neither setting is a credential.
  - None of its settings, as ADR-0008 said: the Model setting would name Codex's own default while threads through the gateway run the file's model and effort.
  - Its `model` only: the effort shown would be Codex's own configured one or the model's, not the file's, which the thread runs.
- How a Codex gateway file reaches Codex, as ADR-0008 weighed it:
  - Pass its settings, token included, in memory (chosen): every Codex gateway file works as written and can be chosen for each thread; a token passes through the app's main process on its way to Codex.
  - Refuse a Codex gateway file that holds a token: no token ever reaches the app, but such files fail until their keys move to Codex's `auth.command` or `env_key`.
  - Let Codex read each file itself, linked into `$CODEX_HOME` as a profile and selected with `--profile`: no token reaches the app, but the app writes into Codex's folder, runs one app-server for each gateway in use and depends on the app-server honouring `--profile`, which is unverified.

## Decision

Providers and gateways are still signed in and configured through the providers' own tools and settings, and the app keeps no secret storage. The app and its remote host components never store, log or show a provider API key or token, and never send one to the renderer. They read or transmit one in a single case: when a Codex gateway file is selected, the main process reads it and passes its settings to Codex for that thread, including a token the file holds, and reads the file again whenever it needs the settings again rather than keeping a copy. Of those settings, the file's `model` and `model_reasoning_effort` alone may also reach the renderer, as the model and the effort a thread through the gateway runs when the session chooses none, and a session keeps those two while it runs; every other setting stays out of logs, errors and the renderer. Claude Code gateway files still reach Claude Code by path, unopened. Invariant 9 in `docs/architecture.md` and `AGENTS.md` stays as ADR-0008 left it.

## Consequences

- Easier: every Codex gateway file works as written, each thread can use a different gateway, and the Model setting names the model and the effort a thread through a gateway runs.
- Harder: a token passes through the main process, so errors, logs and messages to the renderer carry nothing of a Codex gateway file but its model and effort, and those only among a session's models; Codex's errors still have the file's strings hidden.
- Must stay true: only the main process reads a Codex gateway file, to pass its settings to Codex and to take its model and effort for the models. The app names no credential setting in its code, so `scripts/checks/no-provider-keys.sh` keeps applying unchanged. Credentials kept in Codex's `auth.command` or `env_key` keep a token out of the app altogether.

## Revisit when

Codex can load a profile file from another folder, or select a profile for each thread, so that it reads gateway files itself; or its app-server can say which model and effort a thread through a gateway would run, so that the app need not take them from the file.
