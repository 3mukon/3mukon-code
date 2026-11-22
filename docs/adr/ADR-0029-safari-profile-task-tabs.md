---
id: ADR-0029
type: adr
title: Open Safari task tabs in an explicitly connected profile
status: superseded
visibility: public
date: 2026-11-20
summary: Connect a named Safari profile in the app and use one Safari App Extension for owned task tabs and exact-tab previews
scope: ["src/browser/**", "src/app/main/browser-automation.ts", "src/app/main/user-setup.ts", "scripts/build-safari-connector.mjs", "scripts/stage-native-helper.mjs", "scripts/package.sh", "electron-builder.yml"]
tags: []
supersedes: [ADR-0024]
superseded_by: ADR-0031
---

## Context

Most tasks start from an address that the model already has. Reusing Safari sign-ins requires the user's consent to connect a profile by name in the app. The agent uses its own tabs. Safari's separate extension roles report different profile identifiers. Exact inactive-page capture needs a verifiable binding between control and capture.

## Options

| Option | Disposition |
|---|---|
| One Safari App Extension | Proposed for profile connection, native tab creation, isolated page operations and exact-page capture. |
| Safari Web Extension and a separate App Extension | Retain as an alternative if a single extension cannot meet the required background operations. The two roles need a verified binding between their profile and tab identifiers. |
| Borrow an existing tab | Rejected. Setup belongs to a profile and task resources must be created by the adapter. |
| Containing-app dispatch for each background command | Safari may launch in response to the dispatch. Use this API for user-started setup and explicit Open. |

## Decision

Retain the ownership, sharing, presentation and capability rules in [ADR-0024](ADR-0024-browser-resources-and-adapters.md). [ADR-0030](ADR-0030-chrome-profile-task-tabs.md) covers Chrome. Use one App Extension for the Safari candidate if it can establish and verify the user's named profile from Settings or a session's setup notice. Profile discovery is limited to the names and identifiers of eligible profiles. A supported way to obtain the name and connect the corresponding extension instance from the app still needs proof. The public extension context reports an identifier. [Apple Safari extension messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)

The initial profile connection provisions a private loopback link. The app and the Safari extension save the connection proof in their own data. An already running Safari extension initiates recovery for the same authorized profile. The app listens for that connection and gives each successful handshake a new generation. Setup and Open remain explicit user actions. Forget Profile revokes the saved link and closes the live connection.

Reserve a fresh handle for each task tab. The broker admits the first navigation under the ordinary per-tab operation policy, with the requested address and connected profile in the approval. The extension opens an inactive tab in the connected profile. It binds the exact browser-returned tab, independently authenticates the tab's connection, and verifies the live document before delivering observations or frames. Profile setup and tab creation must work without visiting, reading, listing or borrowing the user's tabs. The loopback fixture's anchor page and toolbar setup are evidence from the isolated test profile.

Keep the document and viewport checks around captures. Open in Safari is an explicit user handoff to the same verified tab. Session close and disconnect release task tabs. Tabs that predate the task or that the user took over remain open. A retired document has no authority over its replacement. Safari site permissions and unsupported browser operations get explicit results.

## Consequences

- A model can choose the address in a connected Safari profile. Each session has independent tab handles and operation grants.
- The proposed local package stages the separately signed containing app and extension. The fixture build restricts website access to loopback.
- The ad hoc extension is re-enabled in Safari when Safari disables it. The app starts that step and waits for the saved profile to return. Site access is requested once for all websites through the browser's permission interface. The candidate needs runtime evidence that the saved link and site access recover after this step. [Apple website access permissions](https://developer.apple.com/documentation/safariservices/adjusting-website-access-permissions)
- The candidate needs runtime evidence for named profile selection, profile isolation, background delivery and inactive-page preview before acceptance.
- General website navigation also needs a verified way to intercept attachment responses and enforce the file policy before Safari starts a download. App Extension tab creation accepts a URL and returns a tab. Safari Web Extensions can modify headers through declarative rules. The documented conditions have no tab identifier, so a task-tab rule needs separate proof before using this API. Keep task-tab delivery limited to the verification fixture while this boundary is unresolved. [Safari tab creation](https://developer.apple.com/documentation/safariservices/sfsafariwindow/opentab(with:makeactiveifpossible:completionhandler:)) · [Safari declarative rules](https://developer.apple.com/documentation/safariservices/blocking-content-with-your-safari-web-extension)

## Revisit when

Safari provides a profile-selective background dispatch API, or the single extension cannot satisfy navigation, capture and non-interference together.
