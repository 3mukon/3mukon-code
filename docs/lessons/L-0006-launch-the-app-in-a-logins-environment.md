---
id: L-0006
type: lesson
title: Give the providers a test starts a login's environment, not the test's own
status: active
visibility: public
date: 2026-11-05
summary: A test hands the providers it starts its own environment, through the app, which passes its environment on, or through an adapter in vitest's own process, so tests run from an agent session give the providers that session's base URL, account, sockets and tokens; launch the app through the smoke tests' launchers and run the live tests through their config, which leave the providers only the variables a login gives every program
scope: ["tests/**", "vitest.live.config.ts", "src/**/*.live.test.ts"]
tags: []
level: design
occurrences: 2
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

```text
corepack pnpm run test:live, run from a Claude Code agent session, with the names of the variables
that a process started from a live test inherits, as each adapter's provider does: 98 variables,
among them ANTHROPIC_BASE_URL, CLAUDECODE, 27 CLAUDE_CODE_* ones, HTTPS_PROXY and SSH_AUTH_SOCK,
besides pnpm's and vitest's own, such as npm_lifecycle_event, NODE_ENV, ELECTRON_RUN_AS_NODE and
VITEST_WORKER_ID.
```

## Root cause

Playwright's `electron.launch` gives the app the test's own `process.env` when it is given no `env`, and otherwise the `env` it is given, whole. `launch()` in `tests/smoke/app.ts` gave none, and `launchIsolated()` copied the test's whole environment before pointing the providers' settings into the test's data folder; `tests/smoke/settings.spec.ts` and `tests/package/packaged.spec.ts` did the one or the other. The app passes its own environment on: the Claude Code adapter starts Claude Code with `{ ...process.env, … }`, `claude auth status`, Grok Build and Codex's app-server start with it too, and so do the terminals' shells. A test's environment is that of whatever runs it, and a Claude Code agent session gives the commands it runs its own variables: a base URL for its host, its messaging socket and token, its OAuth scopes, account and organization ids, the host's refresh of its sign-in and many more, besides proxy settings. So the providers that the smoke tests start ran with them. The isolated tests point each provider's settings at an empty folder, which signs it in to nothing, but variables steer a provider as its settings do: `ANTHROPIC_BASE_URL` alone could send a Claude Code probe to the agent's host, to be signed in as the host, where the tests mean to read no account and ask no provider's service.

The live tests (`src/providers/*/main/*.live.test.ts`) start the real providers without the app: they run the adapters inside vitest's own process, which `corepack pnpm run test:live` starts in the environment of whatever runs it, with pnpm's and vitest's own variables added. Each adapter starts its provider in that process's environment: the Claude Agent SDK gives a session `{ ...process.env }` when it is given no `env`, the probes and Codex's app-server get `{ ...process.env, … }`, and Grok Build and `claude auth status` inherit it. So run from an agent session, the providers that the live tests mean to run on the user's own sign-in ran with that session's variables too, its base URL among them.

## Why it looked right

Copying the test's environment keeps `PATH`, `HOME` and the rest of what a program needs, and in a terminal or on a CI runner that environment holds nothing a provider acts on. The isolated launcher's folders seemed to seal the providers off from every account, so only their settings seemed to matter. Nothing failed: the providers answered that they were signed in to nothing, as before, so the variables went unseen until the names in their processes' environment were listed. The live tests run on the user's own sign-in, which each provider reads from its own settings, so the environment seemed to add nothing to it, and vitest's process seemed to be the user's own, as it is when the tests run in a terminal.

## Fix

`loginEnvironment()` in `tests/smoke/app.ts` takes from the test's environment only the variables a login gives every program, `HOME`, `PATH`, `TMPDIR`, `USER`, `LOGNAME` and `LANG`, which `tests/login-variables.ts` lists, where it has them, and `isolatedEnvironment()` adds to them only the providers' folders, `ZDOTDIR` and `SHELL` (L-0007). `launch()`, and so `withApp()`, gives the app that environment; `tests/smoke/settings.spec.ts` and `tests/smoke/retrying.spec.ts`, which launch the app themselves, the latter with Claude Code sent to a local service, and `tests/package/packaged.spec.ts`, which launches the packaged app with launchd's minimal `PATH`, give it the same. The providers' processes now start with those variables, the test's own and the few that the app and the Claude Agent SDK add, such as `CLAUDE_CODE_ENTRYPOINT`. A test that launches the app goes through these launchers or passes `isolatedEnvironment()` as its `env`, and adds any other variable the app needs by name.

`vitest.live.config.ts` runs `tests/live/setup.ts` in vitest's process before each live test file, and it removes from that process's environment every variable but a login's, as `tests/login-variables.ts` lists them, so that each provider starts with those and what its adapter adds; a process started from a live test then inherited only `HOME`, `LOGNAME`, `PATH`, `TMPDIR` and `USER`, besides `LANG` where the test's environment has it. In a live run from the same agent session, Claude Code's, Codex's and Grok Build's processes held those and only what their adapters and the Claude Agent SDK add, such as `CLAUDE_CODE_ENTRYPOINT` and the toolset's credential for Codex. A test that starts a provider through an adapter runs through that config, or leaves its process a login's environment the same way first.

## Occurrences

- 2026-11-05: the smoke tests, run by the check command from a Claude Code agent session, passed that session's variables to every provider's process that the app started.
- 2026-11-05: the live provider tests, run from a Claude Code agent session, started the real providers through the adapters inside vitest's own process, with that session's variables; the guardrail stays at design, the top rung, now in the live tests' config as well.
