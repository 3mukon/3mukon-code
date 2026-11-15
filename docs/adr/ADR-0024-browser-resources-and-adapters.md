---
id: ADR-0024
type: adr
title: Own browser resources separately from their views and connect daily browsers through explicit adapters
status: accepted
visibility: public
date: 2026-11-14
summary: Keep browser contexts independent of panels, using Electron for isolated and app sharing, an extension-backed Chrome connection and two Safari extension roles with explicit binding and capability gates
scope: ["src/browser/**", "src/app/**", "src/toolset/**", "resources/**", "scripts/**", "electron-builder.yml", "package.json", "pnpm-lock.yaml"]
tags: []
supersedes: []
superseded_by:
---

## Context

ADR-0022 separates sharing, background execution and presentation. Recreating a page when its panel opens loses state; copying a daily profile changes the authentication boundary. External browser APIs differ in capture, trusted input and foreground effects.

## Options

| Option | Disposition |
|---|---|
| Owned contexts with embedded, Chrome and Safari adapters | Chosen: explicit sharing with backend-specific capabilities. |
| Copy daily profiles/cookies into the app | Rejected: duplicates authentication storage and loses the original tab. |
| Provider-specific browser engines | Rejected: repeats resource policy and changes semantics per provider. |
| Activate or move a tab whenever capture needs it | Rejected: changes the user's windows during background work. |

## Decision

The browser module owns contexts, leases, observations and view hosts; panels own presentation. `none` is an ephemeral per-session context across turns. `app` is a persistent profile shared across providers, with separate tabs and per-tab grants. `global` explicitly connects an original Chrome/Safari profile without exporting authentication storage. Failure never widens sharing.

Opening defaults to `none`. The model may request an available permitted level, following the user's instruction and otherwise choosing the smallest sufficient scope; the backend does not silently choose a broader identity.

Targets carry opaque context/tab identity and backend generation; observations add document and geometry generations. Titles, URLs and page-provided identifiers are not authority. Discovery exposes installed/connected browser metadata and permitted resources, not unrelated tab URLs. A user's connection flow selects an existing target before the broker requests its operation grant.

| Adapter | Basis and boundary |
|---|---|
| Embedded | Existing Electron 44.9.3 `WebContentsView`, app-owned partitions, sandbox/context isolation and no app preload. Load before attaching a hidden view; show/hide preserves page state. |
| Chrome | Pin the tested Playwright MCP 0.0.85 / extension 0.5.0 route and source revision `84e2bdcaa5a6e4a9e8afcbe8b1bca4ff8a8cb69a`, including transitive implementation pins. Require Chrome 158.0.8127.2 or later; never upgrade or relaunch daily Chrome automatically. |
| Safari control | Packaged Web Extension with native messaging: profile identity from native context, tab identity from browser sender metadata; DOM input is untrusted. |
| Safari page preview | A second App Extension using `SFSafariPage`, with independent per-profile/site readiness and a native binding gate before inactive-page capture. |

Safari's [native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension) supplies `SFExtensionProfileKey`; the [native page proxy](https://developer.apple.com/documentation/safariservices/sfsafaripage) supplies page messaging and capture. These APIs alone do not prove that a Web tab ID and native page proxy name the same receiver. Authenticated channels or shared app storage are not sufficient correlation evidence.

Bind profile, tab, document generation and exact page proxy through browser/native evidence. Matching URLs, titles or DOM-visible nonces is insufficient: pages can relay those values. Until correlation passes cross-profile, same-URL/different-tab, navigation and replay checks, return `page-binding-unverified` before native capture. Use ADR-0022's kept-frame/title fallback. This is an implementation gate, not permission to silently omit inactive-page preview from delivery; unresolved correlation returns to architecture review.

Window-scoped Web capture also needs a trustworthy selection boundary. Pre/post active-tab checks alone cannot guarantee that unrelated content was never captured. Do not enable that route in a general shared window solely on those checks, and do not move user tabs to manufacture exclusivity. Prefer verified target-bound capture or return a limitation.

External previews take no input. Explicit Open checks and selects the original tab/window, then activates its browser through the native layer and verifies the receiver. Background paths never activate. A capture timestamp is distinct from page render time; hidden timers may throttle, so previews promise no continuous refresh.

Disable embedded dialogs at creation; a bounded page compatibility script supplies Cancel semantics for top-level prompt with a typed, untrusted dismissal event. Contain embedded popups, choosers and downloads before they escape. External adapters contain interceptable popup paths and disclose remaining self-activation risk before approval; self-activation grants no desktop input.

Overlay capture has a 100 ms budget: current frame, generation-matching kept frame, then paper. Keep a bounded frame per presented view and coalesce updates. A transparent web layer dims and consumes the focusing click. Hidden work opens no panel. Setup is user-initiated; resource presentation and execution lifetimes follow [DOC-automation-contracts](../automation-contracts.md).

## Consequences

- Page state and sign-ins survive presentation changes across providers.
- Two Safari extension roles need independent setup reporting and a production correlation design; prototype success is not that design.
- Trusted input, freshness and popup containment remain explicit capabilities.
- Supported-version, signing, connection and containment verification remains necessary before shipping.
