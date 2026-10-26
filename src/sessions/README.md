---
id: DOC-mod-sessions
type: doc
title: sessions module
status: current
visibility: public
date: 2026-10-25
summary: The provider-neutral session model, made of the interface every provider adapter implements, the events and requests a session produces, and the state the UI folds from them
scope: ["src/sessions/**"]
tags: []
---

## Responsibilities

- The provider interface (`main/provider.ts`), which each adapter under `src/providers/` implements: `Provider` starts and resumes sessions and lists a folder's past sessions; `ProviderSession` sends the user's messages, interrupts the running turn, answers approvals and questions, switches the permission mode and closes the session. Every provider offers the same two permission modes, `auto` and `yolo`, and sessions start in `auto` (ADR-0006).
- The event model (`shared/events.ts`): the `SessionEvent` union a session reports (turns; streamed messages; tool calls, in the Agent Client Protocol's tool kinds and statuses; the agent's task list; file changes as unified diffs; approvals and questions and their resolution; title, mode, the end of a replay, errors, closing), together with the requests, answers, history entries and permission modes.
- The session state (`shared/session-state.ts`): `applyEvent` folds a session's events into what the UI shows, a timeline in the order things first happened and the current task list; `sessionStatus` derives running, waiting, idle or closed, and `openRequests` lists the approvals and questions still waiting, oldest first.

## Not responsible for

- Speaking a provider's protocol: each adapter maps its provider onto this model (ADR-0005).
- Showing sessions: the session list, the panes and the composer arrive with the session UI, in this module's `renderer/`.
- Hosting the adapters and carrying events to the renderer: the main process does both once the preload bridge exists.
- Credentials: providers sign in through their own tools, and nothing here reads or carries a key or token (ADR-0001).

## Interface

- From `main/provider.ts`, for adapters and the main process: `Provider`, `ProviderSession`, `StartOptions`, `ResumeOptions` and `SessionEventListener`.
- For both processes: the types in `shared/events.ts`, and `applyEvent`, `initialSessionState`, `sessionStatus` and `openRequests` from `shared/session-state.ts`.
- What an adapter must keep to:
  - `start` and `resume` resolve once the provider's session id is known, and the listener receives every event from the first.
  - `resume` replays the session's past events through the same listener, then reports `replay-finished`.
  - `send` is called only while no turn runs and resolves once the provider has accepted the message; `turn-started` and `turn-ended` frame the turn.
  - Every approval and question ends with `request-resolved`; `interrupt`, the end of the turn and `closed` resolve whatever is still open as cancelled.
  - `canAllowForSession` is true only where the provider itself can remember an approval for the rest of the session.
  - File changes are unified diffs, built from whatever form the provider reports them in.
  - The answer to a question marked `secret` is typed into a masked field and never stored or logged.

## Dependencies

- `main/` and `shared/` use nothing outside the module. `shared/` imports no main-process or renderer code, no Node.js built-ins and no Electron, so it runs in both processes; it is type-checked against both the Node.js and the browser configuration.
- Never imports a provider adapter or the app module. The rules `sessions-not-to-providers`, `app-is-the-entry` and the `shared-not-to-*` rules in `.dependency-cruiser.js` enforce this.

## Invariants

- Events, requests, answers and the state are plain JSON-serializable data.
- Text from agents and providers is data to show, never UI copy.
