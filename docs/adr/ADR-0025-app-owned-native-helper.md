---
id: ADR-0025
type: adr
title: Run native automation in a signed helper with app-owned state and explicit control leases
status: accepted
visibility: public
date: 2026-11-14
summary: Use focused PeekabooAutomationKit source in a lazily started signed helper with an explicit coordination root, target-bound observations and cancellable leases, without another model runtime
scope: ["src/computer/**", "src/app/**", "src/toolset/**", "resources/**", "scripts/**", "electron-builder.yml"]
tags: []
supersedes: []
superseded_by:
---

## Context

Native capture and Accessibility need permissions, stable process identity and cancellation beyond a provider request. A full agent CLI adds another reasoning loop and configuration store. ADR-0022 requires background delivery, human takeover and a non-activating floating control.

## Options

| Option | Disposition |
|---|---|
| Focused library behind an app-owned Swift helper | Chosen: reuse tested primitives while the app owns authority and lifecycle. |
| Peekaboo CLI or its agent/MCP server | Rejected: unnecessary inference and configuration surfaces. |
| Rewrite all native facilities | Rejected as the initial route; individual unsafe/unavailable paths remain replaceable. |
| Replay timed-out input or treat dispatch as success | Rejected: effects may already have occurred and may not be reversible. |
| The floating control as the app's own panel window, drawn by the renderer | Chosen: the same look, strings, accessibility and tests as the rest of the window. |
| The floating control as a native panel in the helper | Fallback: probes showed such a panel above full-screen windows without activating, but its words and look would be drawn apart from the app's. |

## Decision

Pin MIT-licensed Peekaboo source at `69764083b16397845dc68b5c0ddb4f674290ae70`, using `PeekabooAutomationKit` and its focused dependency graph; preserve notices. Maintain the small source patch exposing coordination-root and UI-service injection, verified against that revision during the build. All helper instances share one app-owned root. Do not use the physical-home default or import AI/configuration services. An upstream replacement requires a reviewed pin change.

The [manifest](https://github.com/openclaw/Peekaboo/blob/69764083b16397845dc68b5c0ddb4f674290ae70/Package.swift) requires macOS 14 and Swift tools 6.2. This is the native feature's minimum, not an unreviewed change to the whole app's deployment policy.

Package a named helper app at a stable location and signing identity/designated requirement; verify its identity before launch. Release signing/notarization remain separate checks. Start only for a permitted operation or user-requested setup. Use private inherited pipes, a versioned handshake and helper generation: no general scripting endpoint, model-supplied executable, extra inference service or secret-bearing log.

The host owns grants; the helper executes resolved, bounded commands with operation/generation/deadline identity. Revalidate the PID, window, AX element and geometry before dispatch. Restart invalidates every old observation. Exclude the app's windows and helper/control family from listing, capture and actions, including its terminals.

Background AX and window capture never activate, move the shared pointer or use the clipboard. Undocumented WindowServer pointer paths are not a promised baseline: disable routes without supported-version and origin-tagging evidence. Global keyboard/pointer input is explicitly foreground. Unsupported background delivery returns a limitation before disruptive effects.

Do not claim that the helper's sandbox constrains a different application's filesystem writes. Native agent-directed file operations need a known, permitted destination; if workspace-write cannot enforce it, refuse with a capability reason before dispatch. An application grant cannot override file policy.

Mutations acquire application leases; foreground input additionally holds the desktop lease. Stamp every supported injected input route; unclassified input counts as human takeover. Secure Input pauses foreground control. Stop and its shortcut remain available without relying on the monitor. After cancellation, release held input where possible and report partial or indeterminate effects honestly. Retain exclusion while work may still act; never replay an uncertain mutation after a crash.

The floating control is the app's own window, which the main process hosts and the renderer draws in the app's look and words: an Electron window of the macOS `panel` type that stays above other applications, Spaces and full-screen windows without activating, on the target display, with a fixed frame across acting/paused states, naming session and application, not provider. Its clicks change no application's focus. The helper receives its frame, leaves it out of capture and counts input inside it as the control's own, not as a takeover. If verification shows that this window cannot stay above full-screen windows and Spaces without taking the focus, the helper hosts a native panel instead, drawing the words and layout the renderer supplies. A background target's self-activation can show this control without granting desktop input. Permission state names the helper, restart requirements and conditional Input Monitoring; only a user action opens setup or restarts the helper.

## Consequences

- Native work uses existing providers for reasoning and keeps no provider credentials.
- The app owns a native build, small patch, IPC protocol and signature lifecycle.
- The floating control's window belongs to the app, which passes its frame to the helper; the helper's native panel is built only if the app's window fails verification.
- Secure fields/authentication stores are not observation APIs; AX/page content is untrusted.
- Clean-install monitoring, older supported systems, multiple displays, remaining input paths and distribution still need final verification.
