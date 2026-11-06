---
id: DOC-providers
type: doc
title: The three providers side by side
status: current
visibility: public
date: 2026-11-04
summary: Claude Code runs through the Claude Agent SDK in the main process, Codex as an app-server and Grok Build in ACP agent mode, each from a binary that comes with the app and on its own sign-in, and each adapter maps its provider's modes, sandboxes, gateways, models, questions and usage onto the app's one session model, as the table here sets side by side
scope: ["src/providers/**", "src/sessions/shared/**", "src/accounts/shared/**", "package.json"]
tags: []
supersedes: []
superseded_by:
---

The app drives three providers. Each has an adapter module that implements the sessions module's `Provider` and the accounts module's `AccountSource`, so that the rest of the app sees one session model whichever provider runs a session (ADR-0005, ADR-0017). This page sets the adapters side by side; each module's README has the details, and the ADRs cited give the reasons.

## In common

- Each provider runs from a binary that comes with the app, pinned in `package.json` and upgraded deliberately (ADR-0004), never from a CLI the user installed. In the packaged app, the Claude Code and Codex binaries lie beside the app's archive, where macOS can run them; Grok Build's comes compressed, and its adapter unpacks it into the app's data.
- Each provider keeps its own settings and its own sign-in, in its own home folder. The app never reads, stores, logs or shows a provider's key or token, and passes one only with a Codex gateway file's settings to Codex (invariant 9, ADR-0008). Each provider's own sign-in command runs in a terminal panel.
- A session's task list is the one its agent keeps, shown where the provider gives one. The app turns on no provider's task tools: Claude Code offers them by default only to its older models, since its newer ones track their work without a written list, as Anthropic's SDK documentation says, and Codex keeps its plan tool off unless its settings turn it on. The user can turn either on in the provider's own settings (DOC-mod-claude-code, DOC-mod-codex).
- Every session starts in a folder with a permission mode, auto unless the user chose yolo (ADR-0006), and a sandbox level, workspace-write unless the user chose another. Mode, level, model and reasoning effort can change while the session runs; how soon each takes effect is the provider's.
- The Codex and Grok Build adapters drain what their processes log and keep none of it. The providers' processes end as their sessions close and as the app quits.
- Besides its sessions' processes, each adapter starts short-lived ones, its probes, which list its models and read its history or its account. The adapter keeps each probe until its process has exited, which the answer of a Claude Code or Grok Build probe does not wait for (the sessions module's `Probes`), and as the app quits it stops those still running and waits for them, so that none goes on writing to the provider's settings once the app has gone.
- Each adapter has an opt-in live test that drives a real session on the signed-in account (`corepack pnpm run test:live`), which the check command never runs.

## Side by side

| | Claude Code | Codex | Grok Build |
|---|---|---|---|
| Module | [claude-code](../src/providers/claude-code/README.md) | [codex](../src/providers/codex/README.md) | [grok-build](../src/providers/grok-build/README.md) |
| Driven through | The Claude Agent SDK in the main process, which runs the Claude Code binary it brings | `codex app-server`, JSON-RPC over standard input and output (ADR-0003) | `grok agent stdio`, ACP over standard input and output (ADR-0003) |
| Processes | One Claude Code process per session | One app-server per session | One Grok process per session, at the session's sandbox level |
| Settings and sign-in | Claude Code's own, in `~/.claude` or `CLAUDE_CONFIG_DIR` | Codex's own, in `~/.codex` or `CODEX_HOME` | Grok's own, in `~/.grok` |
| Sign-in command | `claude auth login` | `codex login` | `grok login` |
| Auto | Claude Code's auto mode, whose classifier asks the user when it cannot decide | On-request approvals, decided by Codex's automatic reviewer | Grok's auto mode, whose classifier asks the user when it will not allow an action |
| Yolo | `bypassPermissions` | Approvals never asked for | Always approve |
| Sandbox levels | Claude Code's sandbox, set through flag settings; a switch applies at once | Codex's read-only, workspace-write and danger-full-access sandboxes; a switch applies from the next turn | Grok's read-only, workspace and off profiles; a switch moves the session to a new process |
| Gateways | Claude Code settings files, `gateways/<name>.json`, which Claude Code reads | Codex profile files, `gateways/<name>.toml`, which the adapter reads and sends with the thread, naming the file's provider on the thread's app-server (ADR-0008); a running session switches only to a gateway, or to none, on the provider it started with | None; Grok's custom models take their place among its models |
| Models and effort | From Claude Code's initialization; a switch applies at once | `model/list`; a switch applies from the next turn | From Grok's answer to `initialize`; a switch applies at once |
| A message during a turn | Joins the running turn between tool calls | Joins it through `turn/steer` | Joins it through Grok's interjection |
| Retries of a failed request to the model | The SDK's `api_retry` messages, with the retry, of how many, and the HTTP status and Claude Code's kind of error as the reason | Errors Codex will retry, whose message counts them, such as `Reconnecting... 2/5`, with their details as the reason; over its WebSocket transport Codex leaves the first unreported | Grok's `retry_state` notices while it is retrying, with the retry, of how many, and its reason |
| Questions | AskUserQuestion, in yolo too | Codex's own question tools, the async one answered by the user's next message (ADR-0012) | Grok's own question tool |
| Allow for the session | Claude Code's suggested rules, for the session only | Codex's session approval | Not offered: Grok's "always" outlasts the session |
| Task list | Claude Code's task tools, which it offers by default only to its older models, and to the others when its settings turn them on | The turn plan, from the plan tool, which Codex's settings turn on | The plan Grok sends |
| History and resume | The SDK's transcripts and session info | `thread/list`, `thread/turns/list`, `thread/read` and `thread/resume` | `session/list` and `session/load` |
| Usage limits | The SDK's experimental usage call and the turns' rate-limit events | `account/rateLimits/read` and its updates; a reset spends a reset credit | `x.ai/billing`, the plan's current period; no reset |
| The app's toolset | Not given | Given to every session (ADR-0012) | Not given |

## Where things are

- The `Provider` interface: `src/sessions/main/provider.ts`; the session events and the session settings: `src/sessions/shared/` (DOC-mod-sessions).
- The sign-in and usage contract: `src/accounts/shared/` (DOC-mod-accounts).
- The pinned versions: `package.json`. The protocol types Codex's adapter uses are generated from the bundled Codex (`corepack pnpm run codex:protocol`).
