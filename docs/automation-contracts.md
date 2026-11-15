---
id: DOC-automation-contracts
type: doc
title: Proposed automation contracts and change boundaries
status: draft
visibility: public
date: 2026-11-14
summary: Proposed session-owned automation, per-call activity, app-drawn controls and acknowledged panels, with module boundaries, retained target summaries and explicit unavailable or indeterminate outcomes
scope: ["src/sessions/**", "src/toolset/**", "src/browser/**", "src/computer/**", "src/panels/**", "src/app/**", "src/approvals/**", "src/settings/**", "src/files/**", "src/providers/**", ".dependency-cruiser.js", "electron-builder.yml"]
tags: []
supersedes: []
superseded_by:
---

## Proposal status

These are the proposed contracts for ADR-0023 to ADR-0027. They are not an implemented API: the current toolset has no tools and the preload bridge is unchanged. Implementations first land types and controllable fakes for review, before runtime consumers depend on them.

## Authority and data

`src/sessions/shared/automation.ts` extends the provider-neutral session model with serializable automation facts. It imports only existing shared event types, including `PermissionMode`, `SandboxLevel`, `ApprovalAnswer` and `MessageImage`. It owns no policy or backend service. Browser/computer contracts can therefore depend on this leaf without depending on the toolset that calls them.

| Data | Required fields and meaning |
|---|---|
| Owner | App session identity allocated before provider startup; workspace and effective policy held in main, not selected by model arguments. |
| Access | Owner-bound transport generation, revocable independently of the durable session. Credentials never enter shared UI/model data. |
| Target | Opaque handle, kind and backend generation resolved through an owner-scoped registry. Titles, URLs and raw native IDs are not authority. |
| Observation | Target plus document/geometry generations, capture ID, viewport/image dimensions, coordinate units/transform and capture time; render time only when known. |
| Operation/grant | Owner, turn, target, operation kind, policy epoch, state and grant reference. A grant retains its own last-known target summary and summary time, apart from the live resource registry; its scope is operation or session, with issuance and end facts. |
| Tool call | Opaque call ID allocated after caller authentication but before target resolution, policy checks or operation creation; owner, turn, access generation, tool, target summary or unresolved request, sharing, delivery, nullable operation ID, outcome and frames. A panel call carries its presentation's ID, title, kind and resulting state instead of a target, sharing and delivery. |
| Outcome | Verified, dispatched, refused, cancelled-before-dispatch, partial or indeterminate, with bounded data and a code. Cancellation after dispatch never claims no effects. |
| Event/snapshot | Broker epoch, session ID and monotonically increasing sequence. Subscribe before snapshot, discard older buffered events, resnapshot on gaps or epoch change. |

Execution contexts, leases and cancellation controllers stay in main. Shared types describe facts and do not prove authority. Images carry actual bounded bytes in MCP image content and repeat necessary geometry in model-visible structured/text output. A path alone does not establish image support. Preload may use bounded app-owned image resources with the same metadata, never arbitrary filesystem reads.

## Nine UI interfaces

The app's `Bridge` gains feature-owned automation, browser and computer ports. Panels owns its presentation extension. Every main handler validates the trusted app frame and membership; embedded sites and external pages receive none of these ports. Backend results use codes/data; the UI owns translated wording.

| Interface and proposed home | Snapshot/events | Commands/outcomes |
|---|---|---|
| Session automation, `toolset/shared/automation.ts` | Owner's resources, foreground owner, idle/observing/acting/waiting-setup/waiting-grant/paused/stopping state | Snapshot/subscription, stop and end operation. Epoch/sequence support reload and missed events. |
| Browser tabs, `browser/shared/browser.ts` | Owner, sharing/profile/browser, title/address, document generation, loading/error, sign-in-needed or unknown, history, agent/user control | Navigate/back/forward/reload/stop-loading, take control/hand back and explicit Open, with expected target generation. Hand back may need a new approval. |
| Browser view host, same module | View binding/revision, bounds/scale, current/kept frame and failures, overlay/dimmer state, user-input/takeover events | Bind/show/hide/unbind without navigation; resize; cover/uncover for menu/question/drag; dim with UI-supplied color/opacity. Cover returns current frame, matching kept frame with age, or paper within 100 ms. A dimmer click is consumed and reported. Focus only follows a user action. |
| Computer/control, `computer/shared/computer.ts` | `ComputerBridge` supplies permitted applications/windows, previews, Secure Input and takeover/shortcut availability. `ControlWindowBridge` supplies the control window's identity, revision, visibility, foreground owner, display and stable bounds | Observe/preview/reveal/stop/take over/hand back. Main hosts the non-activating window; the renderer draws it and owns its words. Acting/paused changes preserve its position. A separate main-to-helper port supplies verified window identity and geometry for capture/input exclusion. Self-activation shows the control but grants no desktop input. |
| Presentation, `panels/shared/presentation.ts` | Renderer epoch, presentation version, title, owning session, where each open panel lies, and the sessions' own panels | Scoped ID/reuse-key present/update/arrange/close, each carrying the presentation version the agent last saw, and actual acknowledgement/refusal with the current state. Every change the agent's own command did not make reaches the agent as a notice, and `panel_list` returns the current state. A fresh present may reopen; update and old request replay cannot. The user's own reopening, from the activity's Show, is reported to the host, which presents it again and records the state the window answers with; so is Show on the line above the composer, for a tab or application the session uses that no presentation shows, which names the resource for the host to present. The panels module's `shared/presentation.ts` holds the exact commands, answers and placement, with the window's rules and a fake window; no second layout model is introduced. |
| Grants, common session model | Pending target/kind/risk; each grant carries the site, browser and profile ID/name, or application, even after removal from `resources`. End records retain that summary, end time and reason, including `tab-closed` and `application-quit` | Existing allow-once/allow-for-session/deny answers and End. Tag host vs provider request IDs so an answer cannot reach the wrong authority. Composer layout/settings remain unchanged. |
| Setup, feature shared ports | App profile; Chrome installed/minimum version, connection, extension state (`unknown`, `not-installed`, `disabled`, `enabled`) and version, connected profile ID/name or null; each Safari role per profile and each role's website access; helper name, permissions, restart and conditional Input Monitoring | User-only connect/disconnect, exact setup step, clear app sign-ins or restart helper. Model calls return setup-needed; they cannot invoke setup commands. |
| Outcomes, common session model | `AutomationCallRecord` per browser, computer or panel call, its receipt and validated provider-entry link; target/sharing/delivery, typed outcome and frames, including refusals without an operation. Target-self-activated, dialog-dismissed, input-origin and Secure Input events remain separate | Join the existing activity tool entry by the opaque call ID, expose recent records in snapshots and an owner-scoped lookup for older entries. Report checked vs merely dispatched vs refused/stopped/uncertain. Unclassified input counts as human input. No automatic foreground fallback. |
| Tool availability, automation projection | Per-session transport/tools/images ready, unavailable or unknown, with a reason code and typed parameters | Capability lookup uses static/cached facts without starting browsers or prompting for permissions; missing optional setup does not disable unrelated tools. |

The canonical `previewFailureReasons` list, proposed in `sessions/shared/automation.ts`, is `inactive-tab`, `page-binding-unverified`, `site-access-required`, `connection-lost`, `tab-closed`, `permission-required`, `target-state-unsupported` and `application-quit`. Browser, computer and UI contracts use that union; there is no second `target-closed` spelling. Capture time is distinct from render time. Unknown is not silently mapped to success, signed-out or denial.

Availability reasons are a discriminated union: `transport-unsupported` carries the transport; `image-input-unsupported` has no parameters; `os-version-unsupported` carries installed/minimum versions; `browser-version-unsupported` also names the browser; `backend-unavailable` names the backend; `extension-required` and `connection-required` name the browser; `not-probed` has no parameters. These are data for UI-owned translations, never backend-authored display sentences. Feature-specific setup problems leave unrelated tools available.

The control window is an app-owned Electron macOS panel. Verifying its Spaces, full-screen and non-activation behavior decides the host once, and the contract carries only the host chosen: the helper's native panel, which would receive its localized content from the UI through `ControlWindowBridge` rather than the model-facing computer port, is added only if the app's window fails that verification. Nothing switches hosts at runtime. The main-to-helper exclusion names the host-owned native window and process as well as its current geometry; the helper verifies ownership. A model-supplied rectangle cannot suppress human-input detection. Actual app-window behavior remains to be verified.

Direct user interaction and model authority use separate entry points. User navigation/focusing/Open controls do not let a model claim user provenance, and the session's agent sandbox does not prevent the user from manually using their page. The MCP execution port does not expose the user-only setup or focus methods.

An explicit application-discovery request may lazily start the signed helper in metadata-only mode, without window capture/input or a permission prompt. Permission queries must run under the helper's own identity when requested; until queried, report unknown or a dated prior observation rather than presenting the host process's permissions as the helper's.

## Tool-call activity correlation

Every authenticated browser, computer or panel invocation gets an `AutomationCallRecord` before policy or setup can refuse it. The record has a monotonically increasing revision, start/completion times and a phase, and contains a self-contained target summary when resolution succeeds. Otherwise it retains only the bounded, display-safe requested handle/address and target kind, explicitly unresolved. Sharing is the known/requested level or null, never guessed as none; delivery records the requested background/foreground mode, while the outcome says whether anything was dispatched. `operationId` is null until an operation exists. Neither that ID nor the tool name is the activity join key.

The tool result carries an `automation` receipt with `schemaVersion: 1` and the opaque `callId`. The registered toolset's structured result, and its machine-readable text envelope where the provider needs that fallback, carry the same receipt. A provider adapter normalizes it only from that toolset's outer tool-result envelope and native tool-entry metadata. It never searches arbitrary model prose, nested page content or unrelated tools' output for an ID. The host validates the receipt against its own record's owner, turn, access generation and canonical tool name, then binds the provider's existing native tool-entry ID. Missing or unverifiable provenance leaves the ordinary tool entry unjoined; it does not justify guessing by time or name. An ID in output is correlation data, not authority to execute or read another owner's records.

The host stores this validated link with the session history. Record and result may arrive in either order: a bounded pending join and owner-scoped record lookup reconcile them; unknown references time out without an automation row. Replayed receipts and older record revisions are idempotent. A different native entry cannot claim an already linked call, nor can two calls claim one entry. Snapshots expose recent records and links, with `callRecord` for retained older entries, so renderer reload and provider reconnect do not lose completed activity. Records and image retention follow bounded session-history limits; eviction leaves an explicit unavailable image/record, never an unbounded cache or a fabricated result.

The UI augments the existing tool entry with target, sharing, delivery, outcome and frames, including `sandbox-denied` and `setup-required` before an operation, and a panel call's entry with its presentation, which Show presents again. It does not create a duplicate tool entry or append the same screenshot twice from the provider result and broker event. The record's observation IDs identify its authoritative frames. Frame bytes and geometry remain meaningful when the live target leaves `resources`; historical captures remain labeled with their capture time.

## Policy and lifetime

Default presentation is background, delivery is background and panel focus is preserve, independently of sharing. In auto, shared tabs, application observation, foreground input and system dialogs require their operation grant; none-sharing, metadata discovery and panels do not. Read-only refuses mutation/foreground before approval. Workspace-write checks canonical paths against workspace/owned temporary roots; yolo never bypasses these checks. The provider's own approval policy remains separate.

| Trigger | Required result |
|---|---|
| Turn end/Stop | Cancel actions and end operation grants; retain session grants, tabs and shared sign-ins. Retain exclusion until native settlement. |
| Human takeover | End operation, cancel queued work and give control to the user. Hand back starts a new operation under normal authority; a session grant may cover it. |
| Provider reconnect | Same app owner, new access generation; no uncertain mutation replay or transfer of another owner's targets. |
| Policy change | Increment policy epoch and recheck queued work; yolo-to-auto restores grant checks. |
| Session close/archive/removal | Revoke access/operations. Delete its none-sharing context; detach shared/external resources without closing pre-existing user tabs. Records of the user's closes are deleted only with session removal. |
| Panel close | Detach preview only; raise the presentation's version and retain a notice for agent delivery. Terminal close still ends its program and is refused to models; files retain unsaved-change guards. |
| Target ends | End its grants/operations with `tab-closed` or `application-quit`, retaining last-known target summaries in the end records. Registry eviction alone does not erase a grant's display facts. |
| Renderer reload | New epoch and snapshot reconciliation; stale acknowledgements rejected, the user's closes retained. |
| Backend restart | New generation; old observations/leases invalid. Persistent profile identity does not make an old observation current. |

Setup requires trusted user provenance, never a model-supplied Boolean. A target's own activation produces an event and floating control, without authorizing global input.

After any change to a presentation's state that the agent's own command did not make, such as the user closing, moving or resizing its panels, the layout around them changing, another presentation of the session taking its place, the user reopening it from the activity's Show or a window reload, the agent gets a notice of the presentation's latest state: owner, presentation/reuse IDs, title, version, items, which panels are open and where each lies. The agent needs where things stand, not how they came to be, so a notice holds no cause, time or history, and a later change replaces a pending notice for the same presentation. The host reports notices at the next opportunity, in the next toolset result or with the next turn, and `panel_list` returns the session's presentations as they are: each one's version and items, which panels are open and where each lies, and the session's own panels. Reading a snapshot/list or assembling a result does not consume a notice. A notice retires only once the provider's own record shows the result or turn that carried that version or a later one: the result's receipt joined to its provider tool entry, or the turn the provider accepted. So a lost result or a reconnect redelivers it, duplicates keep the same ID, and retiring an earlier notice cannot erase a later change. Presentation state and pending notices survive renderer reload and provider reconnect. For the turn route, sessions exposes a hook that adds pending notices to the next turn it sends, which app composition fills from the toolset, since sessions never imports the toolset.

What a presentation's panels show is the agent's; which of them are open is the user's, who closes them, and a present's, which opens them all. Every panel call for a presentation carries the version the agent last saw, from a tool result, a notice or `panel_list`, which the host checks against its registry and the window against the presentation's current state. On a mismatch the call is refused, and its result gives the presentation's current state, from which the model can try again, so that nothing sent from an outdated picture applies, such as an item meant for one panel landing in another. The version is a freshness check, not authority. An update changes only what the panels show, one item for each panel in order, and never opens or closes one, so a panel the user closed stays closed whatever it shows, even when the user closed them all; only a present changes how many items a presentation has. When the user asks to see a presentation again, from the activity's Show, the renderer reports the request, and the host presents it again at the version in its registry and records the state the renderer answers with. Show on the line above the composer, for a tab or application the session uses that no presentation shows, reports the resource's handle, and the host presents it in a presentation of its own choosing. A fresh `present` with a new command ID may reopen it at the current version, without a click from the user. The tool instructions tell the model not to do so without good reason, such as the user asking; the backend does not classify natural-language intent or treat an arbitrary later turn as user authorization. An old command retry only reports the existing result/current state, never dispatches a new present; reuse with changed arguments is a conflict. A command sent before any change, or its late renderer acknowledgement, cannot undo that change or claim that the presentation is open, since its version no longer matches. An uncertain application is reconciled with the renderer's snapshot, not replayed. Title and owning session travel through the relay for the header and accessibility; panels owns the final public request/placement union.

File bounds are host enforcement, not a claim that the provider's sandbox contains another application's process. Check agent-directed saves, uploads, downloads and picker paths before dispatch. If a native file operation's destination cannot be established or constrained, return `file-scope-unverifiable` in workspace-write rather than dispatching it or treating an operation grant as full access. App-owned profile/cache state is separate from an agent-selected output file.

## Bounds and checks

Proposed initial limits: images are measured by their base64 text, at most 8 MiB for all the frames of one tool result together and for each image artifact, with a longest edge of 4096 pixels; 256 KiB of Markdown, and tables of 1000 rows and 32 columns within 2 MiB of JSON, both in UTF-8. `AUTOMATION_RESULT_LIMITS` in `src/sessions/shared/automation.ts` and `ARTIFACT_LIMITS` in `src/panels/shared/presentation.ts` hold the exact values. One capture is in flight per target and one kept frame per presented view. Preview refresh defaults to at most once per second while presented, with coalesced updates; hidden resources have no presentation polling. Advertise limits and return busy/limit outcomes instead of unbounded queues.

Refresh also requires an active operation authorizing observation. Presenting a cached preview never creates a grant; after operation end, stop refresh and retain an explicitly aged frame or setup/authority state. Overlay display may fit an older frame to new bounds, but that display does not make its geometry valid for an action.

Contract checks cover stale geometry/navigation, revoked queued work, duplicate IDs with changed arguments, cross-owner handles, partial effects, per-call joins, panel calls included, and early refusals, renderer acknowledgement/cancellation races, stale presentation versions, change-notice delivery, the user's own reopening and fresh present versus old retry or update. Fakes include unavailable/denied/stale/stopped/uncertain states, not only success. They are not security boundaries.

## Exact implementation scope

| Owner | Planned files and responsibilities |
|---|---|
| sessions | New `shared/automation.ts`; extend `shared/events.ts` and state/history projection with the validated call-ID/native-tool-entry link. Extend `main/provider.ts` and `main/host.ts` for early owner allocation, bound access and lifecycle callbacks, and add a hook, filled by app composition, that adds pending presentation notices to the next turn. No execution policy here. |
| toolset | Extend `main/server.ts`; add broker/grant/operation and call-record registries, receipts, notice delivery and dispatch in `main/`; `shared/automation.ts` for the UI port and owner-scoped record lookup. Preserve HTTP access protections. |
| browser | New module README, `shared/browser.ts`, `shared/tools.ts`, fakes, and separate main context/view/adapter implementations. |
| computer | New module README, `shared/computer.ts`, `shared/tools.ts`, fakes and main helper/controller lifecycle; separate app control-window and native exclusion ports, with main hosting the window and the renderer drawing its content; source, pinned manifest and patch under `native/`. |
| panels | Panels owner creates `shared/presentation.ts`, renderer fake and version/ack/change/reopen integration. Backend adds its main relay after this contract is reviewed. |
| app | Compose ports in main/preload/shared bridge files; trusted-frame validation and lazy runtime ownership. Renderer changes remain UI-owned. |
| providers | Session-bound access in each adapter's start/resume; normalize registered toolset receipts alongside native tool-entry IDs, without browser/native imports. Preserve explicit model/effort choices and mode on reconnect. |
| files/approvals/settings | App-injected permitted file port, source-tagged host approvals through existing answers, feature setup projections; UI strings remain UI-owned. |
| packaging | Native build script, signed helper/Safari extension resources and `electron-builder.yml`; source/package locks when implemented. This proposal upgrades no dependency. |

The proposed dependency graph is acyclic: sessions shared is the data leaf; browser/computer/panels contracts may type-import it; toolset main may type-import the named feature contracts; app composes runtime implementations. Sessions never imports toolset/browser/computer; provider dependencies stay unchanged.

```mermaid
flowchart TD
  App[App composition] --> Broker[Toolset broker]
  App --> Browser[Browser backend]
  App --> Computer[Computer backend]
  App --> Panels[Panels renderer and relay]
  Broker -. public types .-> Browser
  Broker -. public types .-> Computer
  Broker -. public types .-> Panels
  Browser --> Facts[Sessions shared data]
  Computer --> Facts
  Panels -. data types .-> Facts
  Broker --> Facts
```

Keep `.dependency-cruiser.js`'s no-circular, process-layer and provider restrictions. Extend `toolset-only-to-sessions-contract` only for `browser/shared/tools.ts`, `computer/shared/tools.ts` and `panels/shared/presentation.ts`, with a companion rejection of non-type imports. New browser/computer rules allow their own module, sessions shared, ui and i18n; external access is only through public interfaces/app composition. Panels may add a type-only edge to `sessions/shared/automation.ts`, never a toolset-to-panel-renderer edge. Update module READMEs and these rules together when code lands.

No hard-base/protected-file change is required. Dependency and packaging configuration are not protected. Existing accepted ADR bodies, guards and hooks stay unchanged; ADR-0023 and ADR-0027 supersede ADR-0012 and ADR-0022, whose bodies stay as they were.
