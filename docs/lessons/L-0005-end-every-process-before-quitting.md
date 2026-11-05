---
id: L-0005
type: lesson
title: End every process the app starts, and wait for it, before the app quits
status: active
visibility: public
date: 2026-11-05
summary: A provider's process that the app starts outside its sessions, such as one listing models or reading an account, outlives the app when it still runs as the app quits, and goes on writing to the provider's settings for a second or two, so a smoke test's removal of its data folder fails now and then; keep each such process from its start until it has exited, and have quitting stop those still running and wait for them
scope: ["src/providers/**", "src/sessions/main/provider.ts", "src/app/main/index.ts", "tests/smoke/**"]
tags: []
level: design
occurrences: 1
---

## Symptom

```text
tests/smoke/accounts.spec.ts, the removal of the test's data folder after the app had closed:
Error: ENOTEMPTY: directory not empty, rmdir '/var/folders/…/T/3mukon-code-smoke-bjGzXr'
  at Object.remove (tests/smoke/app.ts:12:7)
It failed once in a run of the check command; six runs of the test alone passed.
```

## Root cause

Quitting closed the sessions, whose processes the adapters end and wait for, but not the processes the adapters start outside their sessions, their probes: Claude Code's models and usage probes and its `claude auth status` command, Codex's short-lived app-servers and Grok Build's short-lived processes, which list models and read the history and the account. `Accounts.close()` stopped the accounts' timer, not a read under way, and a Grok probe answers before its process has exited. A probe still running as the app exited went on without it: the Claude Agent SDK sends its processes SIGTERM as the app's process exits, and Claude Code then takes about two seconds to shut down, rewriting `.claude.json` on the way; Grok goes on starting, writing the files of its home, before it shuts down; Codex's app-server ends once its input does. The smoke tests point each provider's home into the test's data folder, so such a write could recreate a folder that `rmSync` had just emptied, and the last `rmdir` failed.

## Why it looked right

The app closed every session and waited for it, and every probe ends its process in a `finally`, so nothing seemed left to wait for; and an app that has exited seems to take its child processes with it. It does not: a process that quitting ends without waiting goes on for as long as its own shutdown takes. The writes came a second or two after the app had gone, when only a test's cleanup was there to notice, and only when a probe ran at the very moment the test quit, so reruns passed.

## Fix

Every adapter keeps its probes in the sessions module's `Probes` from the moment each starts until it has exited, whoever stopped it, and its `close()`, part of the `Provider` interface, stops those still running, one still starting as soon as it starts, and waits for them. The app calls it for every provider as it quits, beside closing the sessions, within the five seconds it waits. Claude Code's probes spawn their process through the SDK's `spawnClaudeCodeProcess`, so that the adapter knows when it has exited. `tests/smoke/accounts.spec.ts` checks that the providers' processes still running as it quits the app have all exited once the app has closed. Any other process the main process starts outside a session goes through `Probes`, or is ended and waited for as the app quits in some other way.

## Occurrences

- 2026-11-04: `tests/smoke/accounts.spec.ts` failed once in the check command, its data folder's removal refused with ENOTEMPTY.
