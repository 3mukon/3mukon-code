---
id: ADR-0045
type: adr
title: Key a call without an actionId by its tool and arguments, and let browser_open go to an address as a second step of its call
status: accepted
visibility: public
date: 2026-11-27
summary: The broker takes calls without an actionId. One that changes something counts, within its turn, as the earlier call with the same tool and arguments, whose outcome it returns rather than running again, and it keeps ADR-0023's guard against repeating an unsettled effect across turns. One that only reads runs afresh. browser_open with an address opens its tab, then navigates it as a second step of the same call, which the broker checks, schedules and, for a tab with shared sign-ins in auto, asks the user to approve, as it would browser_navigate. A random ID per call, an approval asked before the tab exists, and leaving addresses to browser_navigate were rejected
scope: ["src/toolset/**", "src/app/main/browser-automation.ts", "src/browser/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

**What the action ID does now.** Every browser, computer and panel tool requires an `actionId` that the agent invents. Each tool explains it in about 400 characters. The broker (ADR-0023) uses it as follows:

- **Within a turn,** a repeated ID returns the recorded outcome rather than acting again, and an ID repeated with other arguments is refused.
- **Across turns,** an earlier turn's ID names a new request, except in an exact repeat of a call whose effect is still unsettled. That repeat gets the call back rather than running again, as after a reconnect.
- **The request hash.** The broker already hashes each request by its tool's name and its arguments (`requestKey`), to tell a repeat from a conflict.
- **Fresh observations.** An agent that acts again on a page or a window takes a fresh observation first, as the action tools ask, which changes the next call's arguments.

**What opening a page takes now.** `browser_open` takes no address, so every visit is `browser_open` and then `browser_navigate`. In auto mode, an operation on a browser tab needs the user's grant unless the tab shares no sign-ins (`needsGrant`). The broker asks for one inside `perform`, for a target it has resolved, so it cannot ask before the tab exists.

## Options

| Question | Chosen | Rejected | Why |
|---|---|---|---|
| A call that changes something, without an `actionId` | Keyed by the hash of its tool and arguments, as if that were its ID | A random ID per call; no guard without an ID | A random ID would let a call that the provider sends again, as after a reconnect, act twice. Since an agent that acts again takes a fresh observation, an identical call within a turn is a resend |
| A call that only reads (`readOnlyHint`), without an `actionId` | A key of its own per call, so that it never replays | Keyed by its arguments | A repeated read should see the present state, and reading twice changes nothing |
| An `actionId` the agent gives | Unchanged | — | It keeps the agent in control, a deliberate repeat of a change within a turn among it |
| `browser_open` with an address | Once the tab exists, the broker performs a second plan that the tool returns: navigate the new tab to the address. It goes through the checks, operation, approval and scheduling of `browser_navigate`'s plan, within the same call. The outcome gives the tab and where the page ended up | Asking the approval before the tab exists; refusing an address for a tab with shared sign-ins; navigating inside the browser module, past the broker | Approvals and grants belong to a target the broker has resolved. A second step keeps a shared tab's approval where it is, and costs one call |
| What the tools say | One sentence on each tool about what an `actionId` is for | Keeping the long explanation on every tool | Most calls need none |

## Decision

Everything in the Chosen column:

- The `actionId` is optional on every broker tool.
- Without one, a call that changes something is keyed by its tool and arguments, and a call that only reads runs afresh.
- `browser_open` takes an optional address, which the broker navigates to as a second step of the same call.

## Consequences

- **Easier:** agents call the tools without inventing IDs, and visiting a page takes one call.
- **Harder:**
  - Repeating a change on purpose within a turn, with the same arguments, takes a new `actionId`. Opening two empty tabs in one turn is one such case.
  - A call can now have two steps, so its record can hold an approval and a navigation that its first step did not ask for.
- **Must stay true:** ADR-0023's guards. An unsettled effect is never repeated, changes are serialized per target, and exclusion is kept while a backend may still act.

## Revisit when

- A provider resends calls with changed arguments.
- Another tool needs a second step on a target that its first step creates.
