---
id: ADR-0030
type: adr
title: Connect a Chrome profile once from the app and open task tabs in it
status: accepted
visibility: public
date: 2026-11-20
summary: Pair a Chrome profile once from the app's Settings or a session's notice and let agents open their own inactive tabs in it with its sign-ins, kept until the user disconnects, instead of lending one tab the user picks in Chrome at each connection
scope: ["src/browser/**", "src/app/main/browser-automation.ts", "src/app/main/index.ts", "src/app/main/user-setup.ts", "src/toolset/main/server.ts", "scripts/**", "electron-builder.yml", "package.json", "pnpm-lock.yaml"]
tags: []
supersedes: []
superseded_by:
---

## Context

[ADR-0024](ADR-0024-browser-resources-and-adapters.md) pinned Chrome to the Playwright MCP 0.0.85 route with its extension 0.5.0. Its connection opens the extension's page in the chosen profile, where the user picks one existing tab; the host can then use only that tab. The connection ends with the tab, the relay or the app, and nothing restores it, so every restart asks for a tab again. Profiles are listed by their folder names.

Global sharing exists to reuse a profile's existing sign-ins. Picking tabs one at a time, in Chrome, defeats that purpose. Browser setup belongs in the app, in Settings and a session's setup notices, and a connection should stay until the user disconnects it.

Chrome lends a profile's sign-ins to automation only through an extension in that profile: recent Chrome versions refuse the remote debugging switches for the default data directory.

## Options

| Option | Disposition |
|---|---|
| Keep the pinned Playwright extension route with its tab selection | Rejected: a tab chosen in Chrome at every connection, nothing kept across restarts, and no tabs the host can open. |
| Playwright extension token mode | Rejected. Automatic pairing requires obtaining a token in the extension UI, and connection can start Chrome with a focused window when it is closed. [Playwright extension instructions](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md) |
| The app's own Chrome extension, paired once from the app | Chosen. A native messaging host is registered for the specific extension. The extension opens inactive task tabs and attaches only to the tabs it created. Both sides keep a pairing proof. [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) |
| Remote debugging on the daily profile | Rejected: recent Chrome versions refuse it for the default data directory, and another data directory has none of the user's sign-ins. |
| Driving Chrome's window from the desktop | Rejected: it needs the foreground and interferes with the user's own work. |

## Decision

Connect Chrome at the profile level. Settings, or a session's setup notice, lists the installed profiles by the names the user gave them and connects the chosen one. The app and the extension each save the connection's proof, and the connection resumes by itself after Chrome or the app restarts, until the user disconnects it in the app. While a saved connection waits for Chrome, the app says so.

Agents open their own inactive tabs in the connected profile. The host reads and acts only on tabs it opened for a session, which session close and disconnect close. The user's own tabs are never listed, read or closed, and there is no path that selects or hands over an existing tab. Opening, navigating, observing, acting and previewing follow ADR-0024's rules for owned tabs: scoped handles, document and geometry generations, per-tab operation grants, no activation in the background and an explicit Open. Website access, where Chrome grants it per site, is asked for all sites in the one-time setup.

The native host relays messages to a private app socket. The app accepts a one-use setup invitation and later restores only the saved proof. An isolated Chrome for Testing run verified native Load unpacked, automatic pairing, inactive task tabs and reuse of a synthetic sign-in after Chrome and the app-side connection each restarted. A packaged build then passed the same flow from Settings, through recovery after each restart and Disconnect.

The local app bundle carries the native host and the unpacked extension. On the first Connect action, the app stages the extension at a fixed path in app data. A temporary loopback page in the selected Chrome profile checks whether that profile can see the extension. The page's response only controls setup routing. The app opens the pairing page in that same profile and requires the native one-use invitation. If the extension is missing, the app supplies its folder path and guides the user to Manage Extensions in that Chrome window. Developer mode and Load unpacked provide the first local installation. Setup resumes when the extension becomes available. [Local Chrome extension installation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

This replaces ADR-0024's Chrome adapter route and, for Chrome, its rule that a connection flow selects an existing target. [ADR-0031](ADR-0031-chrome-only-external-browser-reuse.md) defines the release scope for external browsers.

## Consequences

- Existing installations go directly to native pairing. Saved links restore without a setup page or browser launch. The local extension ID comes from the bundled manifest's public key.
- Chrome remembers the extension folder in app data across browser restarts and app bundle moves. A new version of the local extension still needs its update and reload path verified.
- Every agent-opened tab with shared sign-ins still asks for its operation approval in auto mode.
- The extension rejects attachments before document navigation and applies a session-scoped Chrome response rule to each owned tab. The rule adds a sandbox policy that allows site forms, scripts and the original origin. The isolated candidate blocked an HTTP attachment and a page-generated file, while the original tab could download both files. Release testing must cover the policy under ordinary Chrome's extension permissions and across site and navigation variants. [Chrome session rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- Profile names come from Chrome's profile metadata, read for names only; sign-in and other profile data are never read.
- The pinned Playwright route, its adapter and its version evidence no longer apply to Chrome, and the adapter is removed.

## Revisit when

Chrome offers profile-scoped automation without an extension, or the chosen extension's distribution or permissions are refused.
