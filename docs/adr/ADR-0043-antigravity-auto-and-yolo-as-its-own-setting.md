---
id: ADR-0043
type: adr
title: Give an Antigravity session one setting of its own, auto as Antigravity's auto mode in its sandbox and yolo with every request approved and no sandbox, counted as workspace-write and full access
status: accepted
visibility: public
date: 2026-11-27
summary: Each Antigravity session runs `agy acp --process-per-session`, in auto with `--sandbox` and Antigravity's auto mode, or its default mode where the account lacks auto mode, and in yolo with `--dangerously-skip-permissions` and no sandbox; the app's sandbox levels no longer apply to it, the host counts it as workspace-write in auto and as full access in yolo wherever levels are compared, and a switch between the two moves it to a new process; holding Antigravity to the app's levels, offering its other modes, and yolo inside its sandbox were rejected
scope: ["src/providers/antigravity/**", "src/sessions/**", "src/toolset/**", "src/app/**"]
tags: []
supersedes: [ADR-0040]
superseded_by:
---

## Context

Google's Antigravity CLI, `agy`, runs on its own and offers an Agent Client Protocol server, `agy acp`. ADR-0040 settled how the app drives it, from `agy` 1.5.18 as read on 2026-11-26:

- **Protocol:** ACP version 1 over standard input and output.
  - Sessions are created, loaded (with a replay), resumed (without one), listed and closed.
  - Permission requests wait for the client's answer while a turn runs.
  - Questions come as form elicitations to a client that offers them.
  - A prompt sent during a turn steers that turn. Prompts take images and embedded resources.
- **Toolset:** only `agy acp --process-per-session` advertises HTTP MCP servers (`mcpCapabilities.http`), which is how the app passes its toolset to a session (ADR-0023). With the flag, a front process serves each session from a worker process of its own.
- **Modes:** a session has one mode at a time: `default`, `accept-edits`, `auto` or `plan`. `session/set_mode` changes it in place, and refuses `auto` where Google has not rolled it out to the account.
  - `default` asks before edits and commands, as the user's permission settings say.
  - `auto` runs a review of its own on each action, which allows it, denies it or asks the user. It needs the terminal sandbox and turns it on.
- **Terminal sandbox:** `--sandbox` turns on the terminal sandbox for the whole process. The sandbox confines the agent's shell commands with macOS's sandbox. A command that is to run outside it says so in its input (`BypassSandbox`). The agent's own file tools are outside the sandbox. Antigravity keeps them within the workspace unless the user's Antigravity settings allow more.
- **Permissions:** a permission request offers allowing once and denying once. `--dangerously-skip-permissions` approves every request, for the whole process. Antigravity's Turbo preset, which approves every action too, is a setting of the user's own, which `agy acp` takes no way to choose per session.
- **The other providers:** the app has two permission modes, auto and yolo (ADR-0006), and three sandbox levels, set apart from the mode. Auto is each provider's own review, which decides most actions and asks the user only when it cannot. At workspace-write, Codex's review decides, with the user where it cannot, whether a command may run outside Codex's sandbox.

Checks in the app with real accounts on 2026-11-26 showed that Antigravity does not keep to the app's levels:

- **The sandbox follows the mode.** What the sandbox lets a command write depends on Antigravity's mode. In auto mode, a command can write in the session's folder and the temporary folders. In default mode, it can write in the temporary folders only.
- **Auto mode leaves the sandbox on its own.** Auto mode re-ran a command the sandbox had refused outside the sandbox, without a request, so no level below full access binds it. ADR-0040 assumed it would ask first. Auto mode also deleted a file in a temporary folder without asking.
- **Default mode holds but blocks the folder.** Under default mode the sandbox held, and leaving it was asked. But no command could write in the session's folder, so ADR-0040's yolo at workspace-write could not write there at all.

A probe on 2026-11-27 ran `agy acp --process-per-session --dangerously-skip-permissions` without `--sandbox`, in a throwaway folder and home. A command that wrote outside the session's folder ran, and a tool of an HTTP MCP server ran. No permission request reached the client, so the flag reaches the session's worker.

## Options

| Question | Chosen | Rejected | Why |
|---|---|---|---|
| Interface | `agy acp` | Its headless print mode (`-p`); the Antigravity SDK; third-party ACP adapters | Only the ACP server answers approvals and questions while a turn runs, as ADR-0003 found for Grok Build. The SDK and third-party adapters bring a runtime and code of their own |
| Processes | One `agy acp --process-per-session` per session, its flags following the session's mode; short-lived processes for listing models, reading history and reading the account | One front process serving every session; `agy acp` without the flag | Only the flag takes the toolset over HTTP. A process per session lets one session change its flags alone |
| Setting | Auto and yolo, Antigravity's own counterparts of the other providers' modes, and no sandbox level | The app's three levels on Antigravity's sandbox; `plan`, `accept-edits` and `default` as choices | No level below full access binds auto mode. Antigravity's other modes have no counterpart among the other providers' |
| Auto | `--sandbox` and Antigravity's auto mode, or its default mode where the session's modes do not offer auto. Every request that reaches the adapter is asked of the user; one to run a command outside the sandbox says so, with denial preselected | Auto mode without `--sandbox`; the adapter answering requests by a level | Auto mode needs the sandbox. Under the default mode, the sandbox keeps commands in the temporary folders, and leaving it is the user's to allow. A level the adapter holds binds only what Antigravity asks, and auto mode asks little |
| Yolo | `--dangerously-skip-permissions`, without `--sandbox`, in the default mode | Yolo inside the sandbox; the adapter answering every request; the user's Turbo preset | The flag approves every request inside Antigravity, so none reach the app, and the probe found that it reaches the worker. Inside the sandbox, a command that writes outside the temporary folders would fail first and then leave the sandbox anyway. The adapter cannot answer what Antigravity approves itself. The Turbo preset is the user's own setting, shared with every Antigravity they run |
| Comparing levels | The host counts an Antigravity session as workspace-write in auto and full access in yolo: for its children, a child's level against its parent's, the toolset's policy and clicks in other apps | Full access in both | Auto mode keeps commands in its sandbox's writable folders, and its own review decides when one may leave, as Codex's review does at workspace-write. Yolo approves every request, as running without a sandbox does. Counting auto as full access would keep a parent at workspace-write from starting an Antigravity child |
| Switches | A switch between auto and yolo moves the session to a new process with the other flags, which resumes it with `session/resume` and replays nothing. The move happens at once between turns, and otherwise as the turn ends. Entering yolo allows the requests already waiting, and the adapter allows those that come before the move | Restarting at once, which ends the turn | The flags belong to the process, as the sandbox flag did under ADR-0040. A switch to or from full access moved the session the same way, and Grok Build's switch of profile does |

## Decision

Everything in the Chosen column:

- Each Antigravity session runs `agy acp --process-per-session`:
  - in auto, with `--sandbox` and Antigravity's auto mode where offered, or its default mode;
  - in yolo, with `--dangerously-skip-permissions`, no sandbox, and its default mode.
- In auto, every request that reaches the adapter is the user's to answer, but for calls of the app's own tools, which the broker authorizes. In yolo, the adapter allows any request that still comes.
- Antigravity sessions take no sandbox level. The host counts one as workspace-write in auto and full access in yolo, and refuses a level asked for one.

## Consequences

- **Easier:**
  - Antigravity runs as its own tools run it. The app no longer claims a boundary that Antigravity's auto mode does not keep.
  - Yolo runs every action, outside the session's folder too, as yolo at full access does for the other providers.
- **Harder:**
  - In auto, Antigravity's own review decides when a command leaves its sandbox. Its file tools follow its own rule, within the workspace unless the user's Antigravity settings allow more. No level confines an Antigravity session, read-only included.
  - An Antigravity child of a parent at workspace-write can leave its sandbox through Antigravity's review, as a Codex child can through Codex's.
  - Without auto mode on the account, auto runs the default mode. Commands then write only in the temporary folders, and each command that must write elsewhere asks to leave the sandbox.
  - A switch from yolo to auto during a turn takes effect as the turn ends. Until then, Antigravity goes on approving every request.
- **Must stay true:**
  - The process's flags follow the session's mode alone. A child never runs in yolo.
  - Where the user chooses an Antigravity session's mode, and in the confirmation before yolo, the app says that Antigravity's own review, not a sandbox level, decides what its commands reach.
  - The app never changes the user's Antigravity settings.

## Revisit when

- `agy acp` takes settings for one session, such as the Turbo preset, or a mode that asks before leaving its sandbox.
- Auto mode stops leaving its sandbox without a request, which would let a level bind it again.
- `--dangerously-skip-permissions` stops reaching the workers of `--process-per-session`.
