---
id: DOC-mod-sessions
type: doc
title: sessions module
status: current
visibility: public
date: 2026-10-25
summary: The provider-neutral session model, made of the interface every provider adapter implements, the events and requests a session produces and the state the UI folds from them, with the host that runs the app's open sessions and the sidebar's Sessions list
scope: ["src/sessions/**"]
tags: []
---

## Responsibilities

- The provider interface (`main/provider.ts`), which each adapter under `src/providers/` implements: `Provider` starts and resumes sessions, with a gateway, a model, a reasoning effort and a sandbox level when chosen, and lists a folder's past sessions, the gateways set up in the provider's own settings and the models a session could use; `ProviderSession` sends the user's messages, interrupts the running turn, answers approvals and questions, switches the permission mode, the model, the reasoning effort, the sandbox level and the gateway, and closes the session. Every provider offers the same two permission modes, `auto` and `yolo`, and sessions start in `auto` (ADR-0006). Every provider also offers the same three sandbox levels on its own sandbox, set independently of the mode: `read-only`, `workspace-write`, in which the agent writes only in the session's folder and in temporary folders, and `full-access`, without a sandbox; sessions start in `workspace-write`.
- The event model (`shared/events.ts`): the `SessionEvent` union a session reports (turns; streamed messages; tool calls, in the Agent Client Protocol's tool kinds and statuses; the agent's task list; file changes as unified diffs; approvals and questions and their resolution; title, mode, the session's gateway, model, reasoning effort and sandbox level, the models it can switch to, the end of a replay, errors, closing), together with the requests, answers, history entries, permission modes, sandbox levels and model options.
- The toolset's contract (`main/provider.ts`, ADR-0009): `Toolset`, which the toolset module implements and the app hands to the adapters whose providers lack one of its tools; `ToolsetSession`, through which a call asks the session's user; and `ToolsetAccess`, the address and credential one session's provider process uses.
- The session state (`shared/session-state.ts`): `applyEvent` folds a session's events into what the UI shows, a timeline in the order things first happened and the current task list; `sessionStatus` derives running, waiting, idle or closed, and `openRequests` lists the approvals and questions still waiting, oldest first.
- The host (`main/host.ts`): `SessionHost` runs the app's open sessions in the main process, through the providers the app module hands it. It starts a session through its provider, folds the session's events into its state from the first, and lists it once the provider has started it, newest first. Listeners hear when a session joins the list or its title or status changes, not for every event; a closed session stays on the list as closed. `closeAll` closes every session as the app quits.
- The list's contract (`shared/sessions.ts`): `SessionSummary`, what the Sessions list shows of an open session, and `SessionsBridge`, what the window asks of the sessions through the preload bridge.
- The window's part (`renderer/`): `SessionsSection`, the sidebar's Sessions section, with New session just after its heading, disabled until session pages can open, and, while there are folders to choose, a filter just after New session, the ui module's `Select`, which starts in the same place whatever it shows and narrows the list to the sessions in one folder or below it. Each session shows its status as a dot and in words for VoiceOver, its title or else its provider's name, and its folder's name, with the path in the tooltip; without sessions the section shows its heading row alone. `useSessions` keeps the list current through the bridge.

## Not responsible for

- Speaking a provider's protocol: each adapter maps its provider onto this model (ADR-0005).
- Creating the adapters and the toolset: the app module does, and hands the providers to the host.
- Carrying calls and events between the window and the main process: the app module's preload bridge does.
- Which folders the filter offers: the app module passes the workspaces.
- Session pages, the composer and the past sessions in providers' history, which join the list later; the panel area that holds sessions is a module of its own.
- Credentials: providers sign in through their own tools, and nothing here reads or carries a key or token (ADR-0008).

## Interface

- From `main/provider.ts`, for adapters, the toolset and the main process: `Provider`, `ProviderSession`, `StartOptions`, `ResumeOptions`, `SessionEventListener`, `Toolset`, `ToolsetSession` and `ToolsetAccess`.
- From `main/host.ts`, for the app module: `SessionHost`.
- For both processes: the types in `shared/events.ts`, `applyEvent`, `initialSessionState`, `sessionStatus` and `openRequests` from `shared/session-state.ts`, and `SessionSummary` and `SessionsBridge` from `shared/sessions.ts`.
- For the app module's renderer: `SessionsSection` and `SessionFolder` from `renderer/sessions-section.tsx`, and `useSessions` from `renderer/use-sessions.ts`.
- What an adapter must keep to:
  - `start` and `resume` resolve once the provider's session id is known, and the listener receives every event from the first.
  - `resume` replays the session's past events through the same listener, then reports `replay-finished`.
  - `send` is called only while no turn runs and resolves once the provider has accepted the message; `turn-started` and `turn-ended` frame the turn.
  - Every approval and question ends with `request-resolved`; `interrupt`, the end of the turn and `closed` resolve whatever is still open as cancelled.
  - `canAllowForSession` is true only where the provider itself can remember an approval for the rest of the session.
  - File changes are unified diffs, built from whatever form the provider reports them in.
  - The answer to a question marked `secret` is typed into a masked field and never stored or logged.
  - A null gateway stands for the provider's own configuration, a null model or effort for the provider's default. `settings` reports the session's current choices and `models` what it can switch to.
  - `listModels` finds a gateway's models without starting a session, so nothing appears in the provider's history.
  - `setGateway` asked for during a turn takes effect when the turn ends, before the next one. Across a switch the session keeps its id and its history, and reports no `closed`.
  - A sandbox level has one configuration whatever the permission mode, and changing one of the two never changes the other. `setSandbox` takes effect at once where the provider allows it, and otherwise from the next turn. A resumed session takes the level it is given, which the app keeps for it.

## Dependencies

- `main/` and `shared/` use nothing outside the module. `shared/` imports no main-process or renderer code, no Node.js built-ins and no Electron, so it runs in both processes; it is type-checked against both the Node.js and the browser configuration.
- `renderer/` uses the ui and i18n modules, React and react-i18next.
- Never imports a provider adapter, the toolset, the workspaces or the app module. The rules `sessions-not-to-providers`, `sessions-only-to-ui-and-i18n`, `toolset-only-from-app`, `app-is-the-entry` and the `shared-not-to-*` rules in `.dependency-cruiser.js` enforce this.

## Invariants

- Events, requests, answers, summaries and the state are plain JSON-serializable data.
- Text from agents and providers is data to show, never UI copy.
- The host's unit tests drive it with a fake provider (`main/host.test.ts`), and the section is rendered with fixed sessions and folders (`renderer/sessions-section.test.tsx`).
