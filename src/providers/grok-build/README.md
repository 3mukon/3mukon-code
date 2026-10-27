---
id: DOC-mod-grok-build
type: doc
title: grok-build provider module
status: current
visibility: public
date: 2026-10-27
summary: The Grok Build adapter, which drives Grok Build through its ACP agent mode on the user's own Grok sign-in and maps it onto the provider-neutral session model
scope: ["src/providers/grok-build/**"]
tags: []
---

## Responsibilities

- `createGrokBuildProvider` (`main/adapter.ts`) implements the sessions module's `Provider` on `grok agent stdio` (ADR-0003), through the stable API of the ACP TypeScript SDK. Each session has a Grok process of its own, started in the session's folder as `grok --no-plan --sandbox <profile> agent --no-leader stdio`, so that no shared leader process serves it:
  - Binary (`main/binary.ts`): the app depends on the pinned `@xai-official/grok-darwin-arm64` package directly, since the `@xai-official/grok` package around it would copy the binary into the user's Grok home from its install script. The package carries the binary compressed; the adapter unpacks it once per version into a folder of the app's own and runs it from there. A folder that is a link, or that anyone but the user can write to, is refused.
  - Connection (`main/process.ts`): ACP over standard input and output. Grok's log output is drained and never kept. The app tells Grok that it reads and writes no files and runs no terminals for it, so Grok uses its own tools.
  - Start: `session/new` in the session's folder, with `_meta.askUserQuestion`, which has Grok ask through its own question tool; then the mode, and the model and effort if chosen.
  - Resume: `session/load`, which replays the session's updates before `replay-finished`.
  - History: the folder's sessions from `session/list`, page by page, newest first, asked of a short-lived process at the read-only level.
  - Turns: `session/prompt`, which Grok answers when the turn ends, and `session/cancel`, after which the adapter answers what is still open as cancelled. Grok's stop reasons give the turn's outcome.
  - Modes (ADR-0006): `auto` is Grok's auto mode, in which a classifier reviews each action and asks when it will not allow it; `yolo` is its always-approve mode, `bypassPermissions`. `session/set_mode` switches at once, and approvals waiting when the session enters `yolo` are allowed. Grok's own plan mode stays off (`--no-plan`): the app has no plan mode, and Grok asks to leave its plan mode through an undocumented extension request.
  - Sandbox levels: read-only, workspace-write and full access are Grok's `read-only`, `workspace` and `off` profiles, whatever the mode. Grok's `workspace` profile writes in the session's folder, Grok's own home (`~/.grok`) and the temporary folders, and its `read-only` profile in the last two only. Grok applies a profile to its whole process as the process starts, so a switch moves the session to a new process at the new level, which resumes it with `session/resume`, which replays nothing; the mode, model and effort go along. The switch happens at once between turns, and when the turn ends if asked for during one. Should the new process fail, the session goes back to one at its earlier level.
  - Profiles on resume: Grok's own CLI refuses to resume a session under another profile than the one it was saved with, but in agent mode Grok 1.0.70 loads and resumes a session in a process of any profile, and the process's profile is the one in force. The switch relies on that, and the live test checks it.
  - Models and effort: the models the account can choose, with their effort levels and defaults, come from the `modelState` that Grok lists in its answer to `initialize`, so listing them starts no session. A session switches its model and effort at once through ACP's configuration options (`session/set_config_option` with `model` and `reasoning_effort`); going back to the default sets the account's starting model, or the model's own default effort. Grok's custom models, each with an endpoint of its own, are among its models; Grok has no gateways, and the adapter refuses one.
- Translation (`main/translate.ts`): ACP's message chunks carry no ids, so the chunks of one role make one message until something else comes between. Grok's echo of the user's message stays out of live turns and is kept in replays, and updates of other sessions, such as subagents', stay out. Tool calls keep ACP's kinds and statuses, with the command, the files they name, a file tool's `file_path` included, and the text they print. A completed call's diffs become file changes and unified diffs (`main/patch.ts`), in which a file without a text before, or with an empty one as Grok gives a file it creates, is new. The plan becomes the task list; titles, mode updates and the configuration options' model and effort are reported.
- Approvals and questions (`main/requests.ts`): `session/request_permission` becomes an approval with the call's command, files and diff, taken from the call's earlier updates where the request shows less. Grok's "always" answers would outlast the session, so an approval offers allowing once and denying only, and is answered with Grok's once options. Grok's own question tool asks through the `_x.ai/ask_user_question` extension request; every question also takes typed text, as Grok's own question card does, and the answers go back by question text, with the chosen labels and any typed text joined. A question that is declined, that Grok gives up, or that is still open when the turn ends is cancelled.

## Not responsible for

- Signing in: Grok signs in through its own `grok login` and keeps its credentials in its own home; this module never reads or passes them (ADR-0008).
- The app's toolset: Grok's own question tool reaches the app, so its sessions do not open the toolset (ADR-0009).
- Grok's plan mode, its extension methods beyond the question tool (such as fork, rewind and compaction), MCP elicitations, and its own MCP servers, hooks and skills, which run as Grok's settings say.
- The environment of an app opened from the Finder: Grok runs with the app's environment, so a variable that a custom model reads its key from reaches Grok only when the app has it.
- Hosting: the main process runs the adapter and gives it the folder for the binary.

## Interface

- `createGrokBuildProvider(options)` from `main/adapter.ts`, which returns a `Provider` (DOC-mod-sessions). `options.binaryFolder` is the app's folder for the unpacked binary; `options.startGrok` replaces the process, for tests.

## Dependencies

- Uses only the sessions module's interface and model (`src/sessions/main/provider.ts` and `src/sessions/shared/`), the ACP TypeScript SDK `@agentclientprotocol/sdk`, bundled, the `@xai-official/grok-darwin-arm64` binary at run time, `zod`, `diff` and Node.js built-ins. The rules `providers-only-to-sessions-contract` and `providers-not-to-each-other` in `.dependency-cruiser.js` enforce this.
- Only the app module, which hosts providers, may import it.

## Invariants

- Sessions start in `auto` unless the user chose `yolo`; `yolo` is only ever entered by the user's choice.
- A sandbox level's profile never depends on the mode, and switching one never changes the other; every process runs at an explicit profile, `off` included.
- The binary runs only from a folder of the app's own that only the user can write to.
- The unit tests put a fake Grok, on the ACP SDK's own agent side, in place of the process (`main/adapter.test.ts`). The live test (`main/adapter.live.test.ts`) drives a real session on the account's usage, in a throwaway folder outside the temporary folders, which Grok's read-only profile can write to, so only `corepack pnpm run test:live` runs it. It checks that Grok's question tool asks in `yolo`, that read-only stops a write, and that the session can write once switched to workspace-write.
