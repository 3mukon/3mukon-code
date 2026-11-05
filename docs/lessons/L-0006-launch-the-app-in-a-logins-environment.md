---
id: L-0006
type: lesson
title: Launch the app under test in a login's environment, not the test's own
status: active
visibility: public
date: 2026-11-05
summary: A test that launches the app gives it the test's whole environment unless it passes one, and the app passes its environment on to the providers it starts, so a smoke test run from an agent session hands the providers that session's base URL, account, sockets and tokens; launch the app through the smoke tests' launchers, which give it only the variables a login gives every program
scope: ["tests/**"]
tags: []
level: design
occurrences: 1
---

## Symptom

```text
tests/smoke/accounts.spec.ts, run from a Claude Code agent session, with the names of the variables
in the environment of each provider's process that the app started, as ps -E lists them:
claude, codex, grok-1.0.70: 87 to 90 variables each, among them ANTHROPIC_BASE_URL, CLAUDECODE,
CLAUDE_CODE_ACCOUNT_UUID, CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN,
CLAUDE_CODE_OAUTH_SCOPES, CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH, HTTPS_PROXY and SSH_AUTH_SOCK.
The test passed: each provider answered that it was signed in to nothing.
```

## Root cause

Playwright's `electron.launch` gives the app the test's own `process.env` when it is given no `env`, and otherwise the `env` it is given, whole. `launch()` in `tests/smoke/app.ts` gave none, and `launchIsolated()` copied the test's whole environment before pointing the providers' settings into the test's data folder; `tests/smoke/settings.spec.ts` and `tests/package/packaged.spec.ts` did the one or the other. The app passes its own environment on: the Claude Code adapter starts Claude Code with `{ ...process.env, … }`, `claude auth status`, Grok Build and Codex's app-server start with it too, and so do the terminals' shells. A test's environment is that of whatever runs it, and a Claude Code agent session gives the commands it runs its own variables: a base URL for its host, its messaging socket and token, its OAuth scopes, account and organization ids, the host's refresh of its sign-in and many more, besides proxy settings. So the providers that the smoke tests start ran with them. The isolated tests point each provider's settings at an empty folder, which signs it in to nothing, but variables steer a provider as its settings do: `ANTHROPIC_BASE_URL` alone could send a Claude Code probe to the agent's host, to be signed in as the host, where the tests mean to read no account and ask no provider's service.

## Why it looked right

Copying the test's environment keeps `PATH`, `HOME` and the rest of what a program needs, and in a terminal or on a CI runner that environment holds nothing a provider acts on. The isolated launcher's folders seemed to seal the providers off from every account, so only their settings seemed to matter. Nothing failed: the providers answered that they were signed in to nothing, as before, so the variables went unseen until the names in their processes' environment were listed.

## Fix

`loginEnvironment()` in `tests/smoke/app.ts` takes from the test's environment only the variables a login gives every program, `HOME`, `PATH`, `TMPDIR`, `USER`, `LOGNAME` and `LANG`, where it has them. `launch()` and `launchIsolated()`, and so `withApp()`, give the app that environment, `launchIsolated()` with the providers' folders, `ZDOTDIR` and `SHELL` added; `tests/smoke/settings.spec.ts` and `tests/smoke/retrying.spec.ts`, which launch the app themselves, the latter with Claude Code sent to a local service, and `tests/package/packaged.spec.ts`, which launches the packaged app with launchd's minimal `PATH`, give it the same. The providers' processes now start with those variables, the test's own and the few that the app and the Claude Agent SDK add, such as `CLAUDE_CODE_ENTRYPOINT`. A test that launches the app goes through these launchers or passes `loginEnvironment()` as its `env`, and adds any other variable the app needs by name.

## Occurrences

- 2026-11-05: the smoke tests, run by the check command from a Claude Code agent session, passed that session's variables to every provider's process that the app started.
