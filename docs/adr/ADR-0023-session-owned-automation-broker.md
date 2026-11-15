---
id: ADR-0023
type: adr
title: Keep automation authority and lifetime in a session-owned broker behind the shared toolset
status: accepted
visibility: public
date: 2026-11-14
summary: Populate the existing HTTP toolset through a session-owned broker that binds callers before provider startup and owns grants, cancellation and resource lifetimes outside individual MCP requests
scope: ["src/toolset/**", "src/sessions/**", "src/providers/**", "src/app/**", ".dependency-cruiser.js"]
tags: []
supersedes: [ADR-0012]
superseded_by:
---

## Context

ADR-0012 keeps an empty shared toolset ready for more tools. Browser, computer and panel operations now need ADR-0022's operation grants and non-interference behavior. A provider's approval callback and file sandbox do not constrain code inside the app, and an MCP POST is shorter-lived than a tab, approval or native action.

## Options

| Option | Disposition |
|---|---|
| App-owned broker behind the existing HTTP transport | Chosen: one authority and cancellation boundary for every provider. |
| State inside each per-POST MCP server | Rejected: later requests cannot reliably stop or revoke earlier work. |
| Provider approval and sandbox alone | Rejected: neither bounds app-hosted execution. |
| Separate tool services per provider/backend | Rejected: duplicates grants, ownership and lifecycle semantics. |

## Decision

Keep loopback HTTP, exact Host/no-Origin checks, memory-only credentials and per-POST SDK instances. Populate the toolset with browser, computer, capability and panel tools. Codex's own question tool stays its own. ADR-0006's modes and provider mappings remain unchanged.

The sessions host allocates an app session identity before provider startup. The broker binds that identity, workspace and effective policy; the provider receives an access factory already bound to the owner. Native provider IDs and model arguments never select authority. Transport accesses have separate generations, so revoking one cancels its pending work without destroying the durable session's resources.

The broker keeps operations, grants, deadlines, cancellation and deduplication outside HTTP handlers. Resolve opaque handles against owner, backend, target generation and policy epoch; recheck after approval and before queued dispatch. The detailed policy matrix, contracts and file boundaries are in [DOC-automation-contracts](../automation-contracts.md).

In auto, shared-tab use, application background use, foreground input and system dialogs ask once per operation using existing approval answers. Browsing with no sharing, metadata-only discovery and presentation do not ask. A provider's approval cannot satisfy a host grant. Yolo skips questions, while sandbox, ownership and capability checks still apply. Read-only permits observation and opening addresses, never mutation or foreground input. Workspace-write bounds saved/picked files to workspace and owned temporary roots; full-access removes that path restriction.

An operation covers one owner, turn, target and operation kind. It ends on release, turn end, Stop, takeover or revocation. A session grant can authorize later operations on that same target/kind; it is not transferred to a replacement target. Hand back cannot revive an expired once-only grant. Mode/sandbox changes invalidate queued authorizations; yolo-to-auto restores normal grant checks.

Serialize mutations per browser target and native application, and foreground input across the desktop. Retain exclusion while a timed-out backend may still act. Report cancellation before dispatch separately from partial or indeterminate effects after dispatch. Identical repeated action IDs return the known outcome; changed arguments are refused. Never replay an uncertain mutation after reconnect.

Explicit OS activation and background mutations whose declared effects may activate their target also coordinate with the desktop lane, so they cannot race another agent's foreground control. That scheduling exclusion is not a foreground permission and adds no approval to an already allowed background operation.

Interruption stops provider and host work. Closing or archiving a session revokes access and releases operations; session closure deletes isolated contexts but preserves shared profiles and pre-existing external tabs. Provider reconnect rotates access while retaining owner identity; backend restart invalidates observations. App quit drains bounded cancellation and stops owned processes.

Only the HTTP broker starts with the app. Browser contexts, external connections and native helpers start lazily; missing optional backends do not disable chat or unrelated panel tools. Setup starts from a user action.

## Consequences

- All providers share one host policy, including providers that emit approval callbacks in yolo.
- The app needs explicit generations and cancellation settlement, not a request-local controller.
- Images carry actual content and model-visible coordinate/target metadata; a path alone is not image support.
- Page, AX and artifact content cannot grant scope or invoke privileged IPC. Provider credentials never enter these contracts.
- This proposed replacement leaves ADR-0012 accepted until the new decision is confirmed.
