---
id: ADR-0026
type: adr
title: Apply panel tools through acknowledged renderer commands and durable dismissal state
status: accepted
visibility: public
date: 2026-11-14
summary: Keep the renderer authoritative for panel layout while the host sends scoped revision-checked commands, waits for acknowledgement and remembers the user's closes across reconnects and reloads, telling the agent of each and never undoing one with an update
scope: ["src/panels/**", "src/toolset/**", "src/app/**", "src/files/**", "src/sessions/shared/**", ".dependency-cruiser.js"]
tags: []
supersedes: []
superseded_by:
---

## Context

ADR-0027, which replaces ADR-0022, requires focus-preserving presentation, and that the agent be told when the user closes a presentation, which an update never reopens. The renderer owns layout, focus and close guards. Sending IPC alone cannot establish that a result appeared, and closing its presentation does not end its resource.

## Options

| Option | Disposition |
|---|---|
| Revision-checked renderer commands with acknowledgements | Chosen: one layout authority and truthful outcomes. |
| Authoritative layout copies in main and renderer | Rejected: races user drags, reloads and close handling. |
| Return success when IPC is sent | Rejected: the renderer may be absent or refuse the command. |
| Tool handlers directly call layout reducers | Rejected: bypasses unsaved-change and terminal close behavior. |
| Tell the agent of each close and leave reopening to the panel tools' instructions | Chosen: the user's closes hold against updates without a click to confirm each reopening. |
| Refuse a reopening until the user clicks Show | Rejected: asking for a closed result in a message would always take a click as well. |

## Decision

Expose `panel_list`, `panel_present`, `panel_update`, `panel_arrange` and `panel_close` for permitted browser/computer resources, files and bounded Markdown/image/table artifacts. They launch no shell, provider, test, setup flow or arbitrary HTML application. Listing exposes permitted metadata, never terminal output or another owner's private content.

The host resolves caller/content authority and sends command ID, owner, reuse key, presentation revision, expected layout revision and renderer epoch. The renderer revalidates placement, preserves focus and uses existing close guards. Place beside the session or replace only its own prior presentation when space is insufficient; never evict unrelated user panels. Wait for an active drag within a bounded deadline.

Queued commands can cancel without effects. Dispatched commands await a matching acknowledgement before reporting applied. Refusal carries a code. A timeout after dispatch may be uncertain; reconcile instead of blindly resending. Renderer reload invalidates old acknowledgements and starts snapshot reconciliation with a new epoch. The main descriptor cache is bounded and never becomes layout authority.

Identical repeated command IDs return prior outcomes. Reuse keys belong to one caller. A user's close is recorded for the session at once, cancels pending commands for that presentation and is reported to its agent at the next opportunity, in the result of the agent's next toolset call or with its next turn; `panel_list` shows it as closed. An update never reopens a closed presentation and reports the close instead. A new present may reopen it: the panel tools' instructions tell the model not to reopen what the user closed without good reason, such as the user asking for it, and the session's activity lets the user show it again.

Preview closure detaches its view, not execution. Session-view closure leaves the provider running. Model-driven terminal close returns `needs-user-action`, preserving ADR-0016's close-to-terminate behavior. Files retain their existing unsaved-change handling. Artifact type, byte/row limits, owner and expiry are enforced; file paths are checked canonically through a host port. Presented content receives no privileged preload.

The panels module owns its presentation contract and renderer fake. The host consumes that contract through app composition, without introducing a second layout model. [DOC-automation-contracts](../automation-contracts.md) describes the required boundary; focus intent is never OS foreground authority.

## Consequences

- Models receive applied, refused or uncertain results that match the renderer.
- Pending commands, epochs, reconciliation and durable records of the user's closes add explicit state.
- Whether a model reopens a closed presentation rests on its instructions; the host reports each close and keeps updates from undoing it.
- Existing composer layout, approval vocabulary and file/terminal lifetime rules remain unchanged.
