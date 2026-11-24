---
id: ADR-0038
type: adr
title: Run agents' scripts in a page's own context through each engine's debugger session
status: accepted
visibility: public
date: 2026-11-24
summary: browser_evaluate runs a script in the top-level document's own context through the DevTools protocol, the embedded engine's own session and the Chrome extension's session for its task tabs, as a tab action under the tab's existing operation, because the console's semantics are what agents expect and both engines already hold such a session
scope: ["src/browser/**", "src/app/main/browser-automation.ts", "src/sessions/**", "src/approvals/**", "docs/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

The browser tools open addresses, read a bounded semantic snapshot, act on its controls and take screenshots; until now they had no way to run a script, which the browser module stated as a rule. Agents need one for what the snapshot does not show, such as state a page keeps in its own JavaScript, and for what the semantic actions cannot reach, in the app's browser and in Chrome task tabs alike. A script reads what the page's own scripts read, so in a tab with shared sign-ins it reaches the user's data at that site. Both engines already hold a DevTools protocol session for each tab: the embedded engine its own, for dialogs, frames and file choosers, and the Chrome extension one per task tab, through which the app already evaluates its snapshot runner in an isolated world.

## Options

| Option | Outcome |
|---|---|
| `Runtime.evaluate` in the top-level document's own context, through each engine's debugger session, with the console's semantics (`replMode`, `awaitPromise`, `returnByValue`) | Chosen: one path for both engines; the page's variables and functions are reachable; the page's Content Security Policy does not block it; a running script can be ended (`Runtime.terminateExecution`). |
| Evaluation in an isolated world, as the snapshot runner does | Rejected: it reaches the DOM but none of the page's own JavaScript, which is much of what agents need scripts for. |
| `webContents.executeJavaScript` for the embedded engine and `chrome.scripting.executeScript` for Chrome | Rejected: two paths with different semantics; Chrome's extension API runs functions packaged with the extension, not code sent at run time, and the page's policy can block code built with `eval`. |
| A script approval of its own, on top of the tab's operation | Rejected by the maintainer: a script is one more action inside an allowed operation, as clicks and typing are; the operation's approval says scripts may run. |

## Decision

`browser_evaluate` runs the script with `Runtime.evaluate` in the top-level document's own context, with `replMode`, `awaitPromise` and `returnByValue`, without a user gesture, through the embedded engine's own debugger session or the extension's session for a Chrome task tab. It returns the value as JSON, cut at 32 KiB, no value, or the error the script threw; a script is at most 32 KiB and runs for 10 seconds unless the agent asks for up to 30. At its limit, or as the turn stops, `Runtime.terminateExecution` ends what still runs, and the outcome is indeterminate. The extension's fixed list of commands it relays to its task tabs gains `Runtime.terminateExecution`. A script is a tab action with the mutate effect: read-only refuses it, a tab with no sharing never asks, and in a tab with shared sign-ins it runs inside the tab's allowed operation, whose approval says so. A script counts as a new document, which makes the agent's last observation stale. The call's record keeps the script whole, which the activity shows with its result.

## Consequences

- Agents reach what a page's own scripts reach, cookies that are not HttpOnly and the site's storage included, in tabs they own; the tools still offer no API of their own for cookies, storage or form values.
- A script waiting on a promise has nothing running to end: after its limit or a stop it may still go on in the page, and the agent is told only that its outcome is unknown.
- A change to the extension's commands changes its build, which reloads it to the app's build (ADR-0032).

## Revisit when

- A page's scripts need to be reached in other frames, or the DevTools protocol's `replMode` or `terminateExecution` change.
