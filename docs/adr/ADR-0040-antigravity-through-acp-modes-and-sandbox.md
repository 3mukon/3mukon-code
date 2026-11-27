---
id: ADR-0040
type: adr
title: Drive Antigravity through `agy acp` with a process per session, and map the app's modes and sandbox levels onto its modes and terminal sandbox
status: superseded
visibility: public
date: 2026-11-26
summary: Each Antigravity session runs `agy acp --process-per-session`, the only form that takes the app's toolset over HTTP; the process runs the terminal sandbox at read-only and workspace-write and none at full access, auto is Antigravity's auto mode where offered except at read-only, where its default mode runs, and a request beyond the level is asked in auto and denied in yolo, as Codex's escalations are; the headless mode, the SDK, a shared process, plan mode, `--dangerously-skip-permissions` and auto mode at read-only were rejected
scope: ["src/providers/antigravity/**"]
tags: []
supersedes: []
superseded_by: ADR-0043
---

## Context

Google's Antigravity CLI, `agy`, runs on its own and offers an Agent Client Protocol server, `agy acp`. What it does, as read from `agy` 1.5.18 on 2026-11-26:

- **Protocol:** ACP version 1 over standard input and output. Sessions are created, loaded (with a replay), resumed (without one), listed and closed. Permission requests wait for the client's answer while a turn runs. Questions come as form elicitations to a client that offers them. A prompt sent during a turn steers that turn. Prompts take images and embedded resources.
- **Toolset:** only `agy acp --process-per-session` advertises HTTP MCP servers (`mcpCapabilities.http`), which is how the app passes its toolset to a session (ADR-0023). With the flag, a front process serves each session from a worker process of its own.
- **Modes:**
  - `default` asks before edits and commands, as the user's permission settings say. `accept-edits` approves the workspace's edits without asking.
  - `plan` plans before acting: asked to create a file, the agent wrote only its plan, into Antigravity's own data folder, and asked for approval.
  - `auto` proceeds without asking where the terminal sandbox holds an action, and asks to run a command outside it. It needs the sandbox, turns it on, and exists only where Google has rolled it out to the account. Antigravity lists it as the step beyond accept-edits.
  - `session/set_mode` changes the mode at once, and refuses `auto` where it is not offered.
- **Terminal sandbox:** `--sandbox` holds for the whole process and confines the agent's shell commands with macOS's sandbox.
  - In 1.5.18 a command could write in temporary folders but not in the session's folder.
  - The agent may run a command outside the sandbox only through a permission request.
  - The agent's own file tools are outside the sandbox, and Antigravity keeps them within the workspace unless the user's settings allow more.
- **Permissions:** a permission request offers allowing once and denying once, and nothing that outlasts the request. `--dangerously-skip-permissions` approves every request, for the whole process.
- **The other providers:**
  - The app has two permission modes, auto and yolo (ADR-0006), and three sandbox levels, set independently. Auto is each provider's own review, which decides most actions and asks the user only when it cannot, at every level.
  - Each provider's own sandbox enforces the level, its file tools included. Codex's reviewer decides, with the user where it cannot, whether a command may run outside Codex's sandbox in auto, and in yolo none may.
  - The app has no plan mode, and Grok Build's adapter keeps Grok's off.

## Options

| Question | Chosen | Rejected | Why |
|---|---|---|---|
| Interface | `agy acp` | Its headless print mode (`-p`); the Antigravity SDK; third-party ACP adapters | Only the ACP server answers approvals and questions while a turn runs, as ADR-0003 found for Grok Build. The SDK and third-party adapters bring a runtime and code of their own |
| Processes | One `agy acp --process-per-session` per session, and short-lived processes for listing models, reading history and reading the account | One front process serving every session; `agy acp` without the flag | Only the flag takes the toolset over HTTP. A process per session lets one session move to another level alone, as with Grok Build |
| Sandbox levels | The process runs the terminal sandbox at read-only and workspace-write, and none at full access | Plan mode for read-only; workspace-write without the sandbox | Plan mode changes what the agent does, rather than what it can reach, and binds nothing. Read-only needs the adapter's answers either way. Without the sandbox, an allowed command could write anywhere |
| What lies beyond a level | Read-only: edits, and commands outside the sandbox. Workspace-write: commands outside the sandbox, and edits outside the session's folder and the temporary folders. Full access: nothing | Treating every request alike | The adapter tells these apart by the request's tool call: its kind, the paths it names and whether its command asks to leave the sandbox |
| Auto | Antigravity's auto mode at workspace-write and full access, where the session's modes offer it, and its default mode at read-only. Every request that reaches the adapter is asked of the user, one beyond the level marked as such | Auto mode at read-only; auto mode only at workspace-write; accept-edits | At read-only, auto mode would most likely make edits without asking, which the adapter could not refuse, since Antigravity's file tools are outside its sandbox. At full access, auto mode turns Antigravity's sandbox on, but decides and asks as the other providers' auto does, where default mode would ask before every action, which ADR-0006 does not offer. Accept-edits approves edits without any review |
| Yolo | The adapter answers every request itself, in whichever mode runs: it allows one within the level and denies one beyond it | `--dangerously-skip-permissions`; Antigravity's `toolPermission` setting | The flag holds for the whole process, so switching back would restart the session, and it would let commands leave the sandbox. The setting is the user's own, shared with every Antigravity they run |
| Switches | A mode switch, and a switch between read-only and workspace-write, apply at once, through `session/set_mode` and the adapter's answers. A switch to or from full access moves the session to a new process, which resumes it with `session/resume` and replays nothing, as Grok Build's switch of profile does | Restarting the process for every switch | The sandbox flag belongs to the process, and the modes change in place |

## Decision

Everything in the Chosen column:

- Each Antigravity session runs `agy acp --process-per-session`, with `--sandbox` at read-only and workspace-write.
- In auto, Antigravity's auto mode runs at workspace-write and full access, where it is offered, and its default mode at read-only.
- A request beyond the session's level is the user's to allow in auto, and is denied in yolo.

## Consequences

- **Easier:**
  - The adapter speaks the protocol Grok Build's adapter already speaks, with no extension of Antigravity's own.
  - The three levels mean what they mean for Codex. Auto decides by itself and asks only when it must wherever Antigravity offers it, and a mode switch takes effect at once.
- **Harder:**
  - Under the sandbox, a command that must write in the session's folder needs the user's approval to run outside it. In yolo it is denied at read-only and workspace-write, and the agent has to make such a change at workspace-write with its own file tools.
  - At full access in auto, Antigravity's auto mode runs commands in its own sandbox, so one that must write there needs the user's approval too. Yolo at full access runs them without any sandbox.
  - Without auto mode on the account, every command and edit in auto is asked of the user, as Antigravity's default mode asks.
- **Must stay true:**
  - The process's terminal sandbox follows the level alone. Auto mode never runs at read-only, and no request beyond the level is allowed without the user.
  - The app never sets `--dangerously-skip-permissions` or plan mode, and never changes the user's Antigravity settings.

## Revisit when

- Antigravity's terminal sandbox writes in the session's folder.
- Auto mode reaches the accounts the app runs with, and shows whether it asks before edits.
- `agy acp` takes HTTP MCP servers without `--process-per-session`, or adds a way to set the sandbox per session.
- Antigravity's permission requests offer answers that outlast the request.
