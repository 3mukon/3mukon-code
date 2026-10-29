---
id: DOC-mod-sessions
type: doc
title: sessions module
status: current
visibility: public
date: 2026-10-25
summary: The provider-neutral session model, made of the interface every provider adapter implements, the events and requests a session produces and the state the UI folds from them, with the host that runs the app's open sessions, the session pages that start and show them, and the sidebar's Sessions list
scope: ["src/sessions/**"]
tags: []
---

## Responsibilities

- The provider interface (`main/provider.ts`), which each adapter under `src/providers/` implements: `Provider` starts and resumes sessions, with a gateway, a model, a reasoning effort and a sandbox level when chosen, and lists a folder's past sessions, the gateways set up in the provider's own settings and the models a session could use; `ProviderSession` sends the user's messages, interrupts the running turn, answers approvals and questions, switches the permission mode, the model, the reasoning effort, the sandbox level and the gateway, and closes the session. Every provider offers the same two permission modes, `auto` and `yolo`, and sessions start in `auto` (ADR-0006). Every provider also offers the same three sandbox levels on its own sandbox, set independently of the mode: `read-only`, `workspace-write`, in which the agent writes only in the session's folder and in temporary folders, and `full-access`, without a sandbox; sessions start in `workspace-write`.
- The event model (`shared/events.ts`): the `SessionEvent` union a session reports (turns; streamed messages; tool calls, in the Agent Client Protocol's tool kinds and statuses; the agent's task list; file changes as unified diffs; approvals and questions and their resolution; title, mode, the session's gateway, model, reasoning effort and sandbox level, the models it can switch to, the end of a replay, how much of the context window the conversation takes, errors, closing), together with the requests, answers, history entries, permission modes, sandbox levels and model options, which mark the model a session uses when it chooses none and each model's own default effort.
- The toolset's contract (`main/provider.ts`, ADR-0009): `Toolset`, which the toolset module implements and the app hands to the adapters whose providers lack one of its tools; `ToolsetSession`, through which a call asks the session's user; and `ToolsetAccess`, the address and credential one session's provider process uses.
- The session state (`shared/session-state.ts`): `applyEvent` folds a session's events into what the UI shows, a timeline in the order things first happened and the current task list; `sessionStatus` derives running, waiting, idle or closed, and `openRequests` lists the approvals and questions still waiting, oldest first.
- The host (`main/host.ts`): `SessionHost` runs the app's open sessions in the main process, through the providers the app module hands it. It starts a session in a folder through its provider, folds the session's events into its state from the first, and lists it once the provider has started it, newest first. It passes messages, stops and switches to the session, offers its providers, their gateways and their models, found once per provider and gateway for the app's run (a list that fails, or that the provider has not found within a minute, is asked for again next time), and gives each session's state as a snapshot counted in events. Until the provider titles a session, its first message, on one line and shortened, stands in for the title. Listeners hear when a session joins the list or its title or status changes; event listeners hear every event, numbered within its session as the snapshots count them. A closed session stays on the list as closed. `closeAll` closes every session as the app quits.
- Confirmation (`main/native.ts`): `nativeSessionsUi` asks, as a sheet on the window that asked and in the main process's language, before a session runs in yolo; Cancel is the default answer.
- Day folders (`main/folders.ts`): where a session page opens while no workspace has been added, a folder of the day's date in `~/3mukon-code`, such as `~/3mukon-code/2026-10-28`, made only when a session starts there, so that a page closed without a message leaves nothing behind.
- The window's contract (`shared/sessions.ts`): `SessionSummary`, what the Sessions list shows of an open session; `StartRequest`, what a session page starts a session with; `SessionSnapshot`; and `SessionsBridge`, what the window asks of the sessions through the preload bridge: the list, the providers, gateways and models, starting a session with its first message, messages, stops and switches, snapshots and events.
- The window's part (`renderer/`):
  - `SessionsSection`, the sidebar's Sessions section, with New session just after its heading and, while there are folders to choose, a filter just after New session, the ui module's `Select`, which starts in the same place whatever it shows and narrows the list to the sessions in one folder or below it. Each session shows its status as a dot and in words for VoiceOver, its title or else its provider's name, and its folder's name, with the path in the tooltip, and a click or Return shows it; without sessions the section shows its heading row alone. New session and showing a session are the app module's to decide.
  - `SessionPage`, a session page: before its first message it chooses the provider, gateway, model, reasoning effort, permission mode and sandbox level, the gateway only where the provider has gateways and the effort only for a model that takes it, and nothing runs; sessions start in auto and workspace-write. The model starts as the one the provider uses when a session chooses none, under its own name where the provider says which it is and otherwise as Default. The effort starts at medium wherever the model takes it, whatever the provider's own default, else at the model's own default where the provider names it, else at the provider's default, shown as Default. Until the provider's models come, the page says it is loading them, and a session started before they come keeps the provider's own defaults. The first message starts the session, and from then on the page is the session, showing its activity, with everything but the provider still switchable. Choosing yolo asks the user to confirm; a running session's sandbox level switches at once. The composer sends with Return and starts a new line with Shift-Return, leaving Return to an input method while it composes; Stop ends the running turn; how much of the context window the conversation takes shows at its bottom right, as the tokens in use against the window's size with their share of it, such as 25,000 / 200,000 (12.5%), or as the tokens alone where the provider gives no size.
  - `Timeline` (`renderer/timeline.tsx`), a session's activity as the reference's panes show it, in small monospaced type: the user's messages as prompts, the agent's as Markdown (`renderer/markdown.tsx`), its thinking quieter, its tool calls and file changes as rows with their state and line counts, the approvals and questions waiting for the user, errors, then the agent's task list with finished rows struck through and the current one bright, and Working while a turn runs. It keeps its end in view as it grows until the user scrolls up.
  - `useOffers` (`renderer/use-offers.ts`) gives a session page what it offers to choose from, kept once per window for all its pages: the providers, each provider's gateways and the models of each provider and gateway. `preloadOffers` asks for them as the window opens: the providers, then each one's gateways and the models of its own configuration, so that a page shows them as it first appears. The providers and every list of models found are kept, as the host keeps them; gateways are asked for again whenever a page needs them; a list that failed shows as empty and is asked for again when a page next needs it.
  - `useSessions` keeps the list current through the bridge, and `useSession` one session's state: the snapshot, then each event folded the same way, skipping those the snapshot holds.

## Not responsible for

- Speaking a provider's protocol: each adapter maps its provider onto this model (ADR-0005).
- Creating the adapters and the toolset: the app module does, and hands the providers to the host.
- Carrying calls and events between the window and the main process: the app module's preload bridge does.
- Which folders the filter offers, and where New session and a shown session open: the app module decides, and the panel area holds session pages and sessions.
- Answering approvals and questions, which the approvals module does; diffs, which the changes module shows; and the past sessions in providers' history, which join the list later.
- Credentials: providers sign in through their own tools, and nothing here reads or carries a key or token (ADR-0008).

## Interface

- From `main/provider.ts`, for adapters, the toolset and the main process: `Provider`, `ProviderSession`, `StartOptions`, `ResumeOptions`, `SessionEventListener`, `Toolset`, `ToolsetSession` and `ToolsetAccess`.
- From `main/host.ts` and `main/native.ts`, for the app module: `SessionHost`, `nativeSessionsUi` and `SessionsUi`.
- For both processes: the types in `shared/events.ts`, `applyEvent`, `initialSessionState`, `sessionStatus` and `openRequests` from `shared/session-state.ts`, and the types in `shared/sessions.ts`.
- For the app module's renderer: `SessionsSection` and `SessionFolder` from `renderer/sessions-section.tsx`, `SessionPage` from `renderer/session-page.tsx`, `statusDots` from `renderer/timeline.tsx`, `preloadOffers` from `renderer/use-offers.ts`, and `useSessions` from `renderer/use-sessions.ts`.
- What an adapter must keep to:
  - `start` and `resume` resolve once the provider's session id is known, and the listener receives every event from the first.
  - `resume` replays the session's past events through the same listener, then reports `replay-finished`.
  - `send` is called only while no turn runs and resolves once the provider has accepted the message; `turn-started` and `turn-ended` frame the turn.
  - Every approval and question ends with `request-resolved`; `interrupt`, the end of the turn and `closed` resolve whatever is still open as cancelled.
  - `canAllowForSession` is true only where the provider itself can remember an approval for the rest of the session.
  - File changes are unified diffs, built from whatever form the provider reports them in.
  - The answer to a question marked `secret` is typed into a masked field and never stored or logged.
  - A null gateway stands for the provider's own configuration, a null model or effort for the provider's default. `settings` reports the session's current choices and `models` what it can switch to.
  - `listModels` finds a gateway's models without starting a session, so nothing appears in the provider's history. It marks the model a session uses when it chooses none as the default, and gives each model its own default effort, wherever the provider says which they are; it adds no default of its own beside the provider's.
  - `context` reports how many tokens of the model's context window the conversation takes, with the window's size where the provider gives it, whenever the provider counts it anew; `title` reports the title the provider keeps for the session, whether the user gave it or the provider wrote it.
  - `setGateway` asked for during a turn takes effect when the turn ends, before the next one. Across a switch the session keeps its id and its history, and reports no `closed`.
  - A sandbox level has one configuration whatever the permission mode, and changing one of the two never changes the other. `setSandbox` takes effect at once where the provider allows it, and otherwise from the next turn. A resumed session takes the level it is given, which the app keeps for it.

## Dependencies

- `main/` and `shared/` use no other module, but for `main/native.ts`, which uses Electron's dialogs and the i18n module; `main/host.ts` uses Node.js built-ins. `shared/` imports no main-process or renderer code, no Node.js built-ins and no Electron, so it runs in both processes; it is type-checked against both the Node.js and the browser configuration.
- `renderer/` uses the ui and i18n modules, React, react-i18next, and react-markdown with remark-gfm (ADR-0004).
- Never imports a provider adapter, the toolset, the workspaces or the app module. The rules `sessions-not-to-providers`, `sessions-only-to-ui-and-i18n`, `toolset-only-from-app`, `app-is-the-entry` and the `shared-not-to-*` rules in `.dependency-cruiser.js` enforce this.

## Invariants

- Events, requests, answers, summaries and the state are plain JSON-serializable data.
- Text from agents and providers is data to show, never UI copy.
- A session page starts nothing until its first message, and yolo is entered only once the user confirms it (ADR-0006).
- The host's unit tests drive it with a fake provider in real folders (`main/host.test.ts`); the section, the page, the timeline, `useOffers` and `useSession` are rendered with fixed sessions or a fake bridge (`renderer/*.test.tsx`).
