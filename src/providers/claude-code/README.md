---
id: DOC-mod-claude-code
type: doc
title: claude-code provider module
status: current
visibility: public
date: 2026-10-25
summary: The Claude Code adapter, which drives Claude Code through the Claude Agent SDK on the user's own Claude Code sign-in and maps it onto the provider-neutral session model
scope: ["src/providers/claude-code/**"]
tags: []
---

## Responsibilities

- `createClaudeCodeProvider` (`main/adapter.ts`) implements the sessions module's `Provider` with `@anthropic-ai/claude-agent-sdk`, which runs the Claude Code binary it brings along (`@anthropic-ai/claude-agent-sdk-darwin-arm64`):
  - Start: a streaming query under a new session id, in the chosen permission mode (`auto` unless the user chose `yolo`), with Claude Code's own system prompt and with its settings and CLAUDE.md files loaded as in the CLI. A chosen model and reasoning effort go in as the query's `model` and `effort`. Text and thinking arrive as they are written (partial messages).
  - Resume: replays the session's transcript (`getSessionMessages`), then continues the session (`resume`).
  - History: the folder's past sessions (`listSessions`).
  - Modes (ADR-0006): `auto` is Claude Code's auto mode, in which its classifier approves or denies each action and asks through `canUseTool` only when it cannot decide; `yolo` is `bypassPermissions`. Every session starts with skipping permissions allowed, so that it can switch to `yolo` without a restart.
  - Gateways (`main/gateways.ts`): Claude Code settings files named `<name>.json` in Claude Code's gateways folder, `$CLAUDE_CONFIG_DIR/gateways` or else `~/.claude/gateways`, listed by name. A session's gateway file goes to Claude Code by its path, as the query's `settings`; the app never opens it (ADR-0008).
  - Switching: `setModel()` and `applyFlagSettings({ effortLevel })` change the model and the reasoning effort in the running process. A gateway switch ends the process between turns and continues the session in a new one that reads the other file (`resume`), so the session keeps its id and its history; asked for during a turn, it waits for the turn's end. The mode, the model and the effort carry over to the new process.
  - Models: a session's models come from Claude Code's initialization, when it starts and after each gateway switch. Before a session exists, `listModels` asks a Claude Code that loads no settings files and gets no message, so nothing is recorded and no hooks from the user's or a project's settings run. That list leaves out models that the user's own settings add, which the session's own list includes once it starts; hooks in a gateway's file, and managed policy hooks, still run.
- Translation (`main/translate.ts`): assistant text and thinking stream in as message deltas, and the complete message that follows adds only its tool calls; tool calls become tool events in ACP's tool kinds; TodoWrite, TaskCreate and TaskUpdate become the task list; Edit and Write become file changes, with unified diffs from the edit tools' structured patches, or rebuilt from an edit's strings in a transcript; each turn's init message gives the mode and the model in use; results end turns. An error that Claude Code gives instead of an answer, such as a missing sign-in, is reported once, with the turn that fails.
- Approvals and questions (`main/requests.ts`): every `canUseTool` call becomes an approval, or a question for AskUserQuestion; ExitPlanMode, which ends a plan mode that Claude entered by itself, becomes a plan approval, after which the session returns to its own mode. "Allow for the session" adds Claude Code's suggested rules for the session only, and is offered only when Claude Code suggests rules that may be kept. Answers to questions go back in the tool's input, keyed by question text. Questions reach the user in `yolo` too: Claude Code sends AskUserQuestion to `canUseTool` even in `bypassPermissions`, although the SDK warns that `canUseTool` is not invoked there; the live test checks it.
- Paths in tool calls, approvals and file changes are relative to the session's folder when they lie inside it.

## Not responsible for

- Signing in: Claude Code signs in through its own `/login` and keeps its credentials itself; this module never reads or passes them (ADR-0008). Without a sign-in, a turn fails with Claude Code's own message.
- Subagents' activity and Claude Code's background tasks: not shown in this version.
- Hosting: the main process runs the adapter. A packaged app opened from the Finder does not inherit the shell's PATH, which Claude Code's commands may need; packaging has to provide it.

## Interface

- `createClaudeCodeProvider(options)` from `main/adapter.ts`, which returns a `Provider` (DOC-mod-sessions); `options.gatewaysDir` replaces the gateways folder, for tests.

## Dependencies

- Uses only the sessions module's interface and model (`src/sessions/main/provider.ts` and `src/sessions/shared/`), the Claude Agent SDK, `diff` and Node.js built-ins. The rules `providers-only-to-sessions-contract` and `providers-not-to-each-other` in `.dependency-cruiser.js` enforce this.
- Only the app module, which hosts providers, may import it.

## Invariants

- Sessions start in `auto` unless the user chose `yolo`; `yolo` is only ever entered by the user's choice.
- Gateway files are listed and passed by path, never opened.
- The unit tests of the adapter (`main/adapter.test.ts`) put a fake process in place of the SDK's `query`. The live test (`main/adapter.live.test.ts`) drives a real session in a throwaway folder, with a throwaway gateways folder. It needs Claude Code signed in and uses a little of the account's usage, so only `corepack pnpm run test:live` runs it, never the check command.
