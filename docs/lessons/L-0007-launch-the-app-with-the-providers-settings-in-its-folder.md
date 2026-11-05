---
id: L-0007
type: lesson
title: Launch every app under test with the providers' settings in its throwaway folder, since the app runs them unasked
status: active
visibility: public
date: 2026-11-05
summary: The app runs every provider of its own accord, listing their models as its window opens and reading their accounts five seconds later, so a smoke test that tests nothing of the providers still runs them, and launched in a login's environment alone, on the user's own settings and sign-ins; launch the app through the smoke tests' launchers, which all point each provider's settings into the test's throwaway folder, where it is signed in to nothing
scope: ["tests/**"]
tags: []
level: design
occurrences: 1
---

## Symptom

```text
sh scripts/check.sh, with the names of the variables in the environment of each provider's process
that the smoke tests' apps started, as ps -E lists them: the tests launched by launch() and withApp()
in tests/smoke/app.ts and by tests/smoke/settings.spec.ts's own launcher started 22 Claude Code
processes through the Claude Agent SDK, one Codex app-server and one Grok Build, none of them with
CLAUDE_CONFIG_DIR, CODEX_HOME or GROK_HOME, so they read ~/.claude, ~/.codex and ~/.grok, the
user's sign-ins included. Every test passed. The same day, tests/smoke/settings.spec.ts timed out
once at 30 s, with a teardown of 1.8 minutes, while launching on those settings, and passed 3 of 3
alone.
```

## Root cause

Only `launchIsolated()` in `tests/smoke/app.ts`, which the accounts' and the terminals' smoke tests used, and `launchAgainst()` in `tests/smoke/retrying.spec.ts` pointed each provider's settings into the test's throwaway folder with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME`. `launch()`, and so `withApp()`, and the settings' smoke test gave the app a login's environment alone (L-0006), whose `HOME` leads each provider to the user's own settings. The app runs the providers whatever a test does: as its window opens, it asks every provider for its gateways and the models of its own configuration, which starts a Claude Code through the SDK, a Codex app-server and a Grok Build; five seconds later it reads every provider's sign-in and usage (ADR-0017); ten seconds later its search reads the history of each session it keeps no text for (ADR-0014). So each of those tests ran the providers on the user's sign-ins, with which they ask their services as the user, and a test running past five seconds would read the user's accounts, and past ten look for its sessions' histories among the user's own.

## Why it looked right

The isolated launcher came with the first tests that ask the providers something, the accounts' and the terminals', so pointing the providers at empty settings seemed to belong to tests about the providers. The other tests start no session, and those that show sessions answer the main process's calls themselves so that no provider runs. The processes the window starts as it opens are short-lived and show nothing a test checks: on the user's settings they listed the user's models, every test passed, and nothing showed that they ran until the names in their environment were listed.

## Fix

`isolatedEnvironment()` in `tests/smoke/app.ts` is the one environment the app under test starts in: a login's (L-0006), with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME` pointing into folders it makes inside the test's throwaway folder, where each provider is signed in to nothing, and with `ZDOTDIR` and `SHELL` set so that a terminal's shell reads none of the user's startup files. `launch()`, and so `withApp()`, gives the app that environment, so `launchIsolated()`, which differed from it in nothing else but English, is gone, and the tests that used it pass `--lang=en-US` to `launch()`. `tests/smoke/settings.spec.ts`, `tests/smoke/retrying.spec.ts` and `tests/package/packaged.spec.ts`, which launch the app themselves, give it the same environment, the latter two with their own variables added by name. No launcher offers a login's environment without the providers' folders. In a run of the check command after the fix, every provider's process whose environment `ps -E` could read had the three variables, each pointing into its test's throwaway folder.

## Occurrences

- 2026-11-05: the smoke tests launched by `launch()`, `withApp()` and the settings' smoke test ran Claude Code, Codex and Grok Build on the user's own settings and sign-ins.
