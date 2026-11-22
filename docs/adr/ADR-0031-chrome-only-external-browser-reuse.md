---
id: ADR-0031
type: adr
title: Use Chrome for external browser sign-in reuse
status: accepted
visibility: public
date: 2026-11-21
summary: Offer the built-in browser and Chrome, with Chrome as the external browser for reusable sign-ins
scope: ["src/browser/**", "src/app/**", "src/toolset/**", "src/sessions/**", "src/i18n/**", "scripts/**", "tests/**", "electron-builder.yml", "docs/**"]
tags: []
supersedes: [ADR-0029]
superseded_by:
---

## Context

An external browser adapter needs to connect the named profile in the app, reuse its sign-ins and contain the effects of tasks in tabs it owns. Safari's public extension interfaces identify a profile by ID. The available network rules cannot scope response handling to a task tab. A loopback fixture proved background actions and preview in a single synthetic profile.

## Options

| Option | Disposition |
|---|---|
| Safari App Extension or Safari Web Extension | Withdrawn. The public interfaces leave named profile selection and task-tab download containment unresolved. |
| Safari WebDriver | Rejected. The automation session has its own data and cannot reuse the everyday browser profile. |
| Built-in browser and Chrome | Accepted. The built-in browser supplies the isolated and app-sharing contexts. The Chrome connector supplies reusable external sign-ins and task-owned tabs. |

## Decision

Offer Chrome as the only external browser for global sharing. Keep the built-in browser as the default. The app connects a Chrome profile from Settings or a session setup notice using the local extension route in [ADR-0030](ADR-0030-chrome-profile-task-tabs.md).

Remove the Safari installation and execution paths from the app. An explicit Safari tool request fails validation before allocating a tab. Older activity can still display its recorded browser name.

This decision replaces the Safari portion of [ADR-0024](ADR-0024-browser-resources-and-adapters.md) and supersedes [ADR-0029](ADR-0029-safari-profile-task-tabs.md).

## Consequences

The Chrome profile, its existing sign-ins and the app's browser remain available to providers. Browser setup, tools and packaging no longer offer Safari.

## Revisit when

Safari supplies supported profile selection and an effective file policy scoped to task-owned tabs.
