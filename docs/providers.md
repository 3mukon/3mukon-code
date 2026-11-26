---
id: DOC-providers
type: doc
title: The four providers side by side
status: current
visibility: public
date: 2026-11-04
summary: Claude Code runs through the Claude Agent SDK in the main process, Codex as an app-server, Grok Build in ACP agent mode and Antigravity through its ACP server, each from the user's own CLI or else from a copy the app downloads at sign-in, and on its own sign-in, and each adapter maps its provider's modes, sandboxes, gateways, models, questions and usage onto the app's one session model, as the table here sets side by side
scope: ["src/providers/**", "src/installs/**", "src/sessions/shared/**", "src/accounts/shared/**", "package.json"]
tags: []
supersedes: []
superseded_by:
---

The app drives four providers. Each has an adapter module that implements the sessions module's `Provider` and the accounts module's `AccountSource`, so that the rest of the app sees one session model whichever provider runs a session (ADR-0005, ADR-0017). This page sets the adapters side by side; each module's README has the details, and the ADRs cited give the reasons.

## In common

- Each provider runs from the user's own CLI where one at or above the oldest version its adapter drives is on the PATH, and otherwise from the app's own copy (ADR-0039, DOC-mod-installs).
  - The app's copy is the provider's official build at the version and checksum the app pins, from the provider packages in `package.json`, and for Antigravity from Google's update manifest.
  - The app downloads it into its data folder when the user signs in, or at the next sign-in or session once a build pins a newer version.
  - The app carries no provider's binary.
- Each provider keeps its own settings and its own sign-in, in its own home folder. The app never reads, stores, logs or shows a provider's key or token, and passes one only with a Codex gateway file's settings to Codex (invariant 9, ADR-0028). Each provider's own sign-in command runs in a terminal panel.
- A session's task list is the one its agent keeps, shown where the provider gives one. The app turns on no provider's task tools: Claude Code offers them by default only to its older models, since its newer ones track their work without a written list, as Anthropic's SDK documentation says, and Codex keeps its plan tool off unless its settings turn it on. The user can turn either on in the provider's own settings (ADR-0020; DOC-mod-claude-code, DOC-mod-codex).
- Every session starts in a folder with a permission mode, auto unless the user chose yolo (ADR-0006), and a sandbox level, workspace-write unless the user chose another. Mode, level, model and reasoning effort can change while the session runs; how soon each takes effect is the provider's.
- The Codex, Grok Build and Antigravity adapters drain what their processes log and keep none of it. The providers' processes end as their sessions close and as the app quits.
- Besides its sessions' processes, each adapter starts short-lived ones, its probes, which list its models, read its history or its account, and write the titles of sessions their provider leaves untitled, which run no tools and leave no session in the provider's history (ADR-0035, ADR-0037). The adapter keeps each probe until its process has exited, which the answer of a Claude Code or Grok Build probe does not wait for (the sessions module's `Probes`), and as the app quits it stops those still running and waits for them, so that none goes on writing to the provider's settings once the app has gone.
- Each adapter has an opt-in live test that drives a real session on the signed-in account (`corepack pnpm run test:live`), which the check command never runs.

## Side by side

| | Claude Code | Codex | Grok Build | Antigravity |
|---|---|---|---|---|
| Module | [claude-code](../src/providers/claude-code/README.md) | [codex](../src/providers/codex/README.md) | [grok-build](../src/providers/grok-build/README.md) | [antigravity](../src/providers/antigravity/README.md) |
| Driven through | The Claude Agent SDK in the main process, which runs the `claude` the installs module chooses | `codex app-server`, JSON-RPC over standard input and output (ADR-0003) | `grok agent stdio`, ACP over standard input and output (ADR-0003) | `agy acp`, ACP over standard input and output (ADR-0040) |
| Processes | One Claude Code process per session | One app-server per session | One Grok process per session, at the session's sandbox level | One `agy acp --process-per-session` per session, whose front process serves it from a worker of its own |
| Settings and sign-in | Claude Code's own, in `~/.claude` or `CLAUDE_CONFIG_DIR` | Codex's own, in `~/.codex` or `CODEX_HOME` | Grok's own, in `~/.grok` | Antigravity's own, in `~/.gemini`, and its sign-in in the macOS keychain |
| CLI, and the oldest version the adapter drives | `claude`, from the SDK's `claudeCodeVersion` | `codex`, from the version its protocol types come from | `grok`, from the version its ACP use was written against | `agy`, from the version its ACP use was written against |
| The app's copy | The Claude Agent SDK's package for macOS on Apple silicon, which carries that Claude Code; it runs with Claude Code's updater off | Codex's build for macOS on Apple silicon, with the tools beside its binary | Grok Build's build for macOS on Apple silicon, its binary compressed with brotli | Google's build for macOS on Apple silicon, from the versioned address and SHA-512 that Google's update manifest gave for it; it runs with its updater off |
| Sign-in command | `claude auth login` | `codex login` | `grok login` | `agy acp --login` |
| Auto | Claude Code's auto mode, whose classifier asks the user when it cannot decide | On-request approvals, decided by Codex's automatic reviewer | Grok's auto mode, whose classifier asks the user when it will not allow an action | Antigravity's auto mode where the account has it, except at read-only; elsewhere its default mode, which asks before edits and commands |
| Yolo | `bypassPermissions` | Approvals never asked for | Always approve | The adapter allows every request within the level and denies one beyond it |
| Sandbox levels | Claude Code's sandbox, set through flag settings; a switch applies at once | Codex's read-only, workspace-write and danger-full-access sandboxes; a switch applies from the next turn | Grok's read-only, workspace and off profiles; a switch moves the session to a new process | Antigravity's terminal sandbox at read-only and workspace-write, none at full access; a switch to or from full access moves the session to a new process, and a request beyond the level is asked in auto |
| Gateways | Claude Code settings files, `gateways/<name>.json`, which Claude Code reads | Codex profile files, `gateways/<name>.toml`, which the adapter reads and sends with the thread, naming the file's provider on the thread's app-server (ADR-0028); a running session switches only to a gateway, or to none, on the provider it started with | None; Grok's custom models take their place among its models | None |
| Models and effort | From Claude Code's initialization; a switch applies at once | `model/list`, with the defaults that `config/read` names for the session's folder; a switch applies from the next turn | From Grok's `x.ai/models/list`; a switch applies at once | The `model` and `thought_level` configuration options, third-party models included; a switch applies at once |
| A message during a turn | Joins the running turn between tool calls | Joins it through `turn/steer` | Joins it through Grok's interjection | Steers the running turn as a prompt of its own |
| Retries of a failed request to the model | The SDK's `api_retry` messages, with the retry, of how many, and the HTTP status and Claude Code's kind of error as the reason | Errors Codex will retry, whose message counts them, such as `Reconnecting... 2/5`, with their details as the reason; over its WebSocket transport Codex leaves the first unreported | Grok's `retry_state` notices while it is retrying, with the retry, of how many, and its reason | Not reported |
| Questions | AskUserQuestion, in yolo too | Codex's own question tools, the async one answered by the user's next message (ADR-0012) | Grok's own question tool | Antigravity's own question tool, through ACP's form elicitation |
| Allow for the session | Claude Code's suggested rules, for the session only | Codex's session approval | Not offered: Grok's "always" outlasts the session | Not offered: Antigravity offers allowing once only |
| Task list | Claude Code's task tools, which it offers by default only to its older models, and to the others when its settings turn them on | The turn plan, from the plan tool, which Codex's settings turn on | The plan Grok sends | None: Antigravity sends no plan |
| History and resume | The SDK's transcripts and session info | `thread/list`, `thread/turns/list`, `thread/read` and `thread/resume` | `session/list` and `session/load` | `session/list`, picked out by folder, and `session/load` |
| Usage limits | The SDK's experimental usage call and the turns' rate-limit events | `account/rateLimits/read` and its updates; a reset spends a reset credit | `x.ai/billing`, the plan's current period; no reset | Not offered to programs; shown as unavailable |
| The app's toolset | Bound HTTP MCP through SDK configuration | Bound HTTP MCP through app-server configuration | Bound HTTP MCP on new/load/resume when advertised, as `sanmukon-code`, since Grok takes no server name that starts with a digit; otherwise explicitly unavailable | Bound HTTP MCP on new/load/resume as `3mukon-code`, its tools named `mcp_3mukon-code_<tool>`; a call's result does not come back to the app |
| Titles (ADR-0035, ADR-0037) | Claude Code's own AI title, from the first prompt; where it gives none, one from a Claude Code of its own without tools, servers or a transcript, given back as the custom title with `renameSession` | The app's, once the session has run for a while, from an ephemeral thread of a probe app-server, given back as the thread's name with `thread/name/set` | Grok's own; where it gives none, one from a probe's session, deleted after with the undocumented `_x.ai/session/delete`, given back with the undocumented `_x.ai/session/rename` | Antigravity's own: the first message, then a title it writes once a turn has run |
| Notices of new messages (ADR-0036) | A document beside the user's message, or alone in a turn of the app's | A text input marked as the app's, beside the user's message or alone | A resource beside the user's message, or alone | A resource beside the user's message, or alone |

## Where things are

- The `Provider` interface: `src/sessions/main/provider.ts`; the session events and the session settings: `src/sessions/shared/` (DOC-mod-sessions).
- The sign-in and usage contract: `src/accounts/shared/` (DOC-mod-accounts).
- The pinned versions: `package.json`. The pins of the app's copies: each adapter's `pin.json`, which `corepack pnpm run providers:pins` writes from the lockfile and `tests/contracts/provider-pins.test.ts` keeps equal to it; Antigravity's, which `corepack pnpm run providers:pins --antigravity` writes from Google's update manifest and the test keeps in the form of Google's builds. The oldest versions: each adapter's `main/install.ts`. The protocol types Codex's adapter uses are generated from the pinned Codex package (`corepack pnpm run codex:protocol`).
- Where each provider's processes come from: `src/installs/` (DOC-mod-installs).
