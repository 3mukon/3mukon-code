---
id: ADR-0001
type: adr
title: Keep provider credentials and gateway tokens in the providers' own settings
status: superseded
visibility: public
date: 2026-10-23
summary: The app and its remote host components never hold provider API keys or gateway tokens; gateways are configured in each provider's own settings, rather than stored in the Keychain or dropped
scope: []
tags: []
supersedes: []
superseded_by: ADR-0008
---

## Context

The desktop app drives Claude Code, Codex and Grok Build through their own SDKs and CLIs, and each provider signs in through its own tool. Some setups route a provider through a third-party gateway, which needs a token of its own. Invariant 9 said that the app never handles provider API keys, but not whether that covers gateway tokens, or components that run on remote hosts.

## Options

- Keep every credential in the providers' own settings (chosen). The app passes no token; a gateway is configured where the provider already reads its configuration, for example the `env` block of Claude Code's settings.
- Store gateway tokens in the macOS Keychain and pass them to the provider. Configuration lives in one place, but the app would hold secrets it could leak, and invariant 9 would need an exception.
- Drop gateway support. Simplest, but it removes a setup that the providers' own tools support.

## Decision

Invariant 9 covers the app and its remote host components, and every kind of provider credential: API keys and tokens, gateway tokens included. Providers and gateways are signed in and configured through the providers' own tools and settings; the app only uses providers that are already set up.

## Consequences

- The app needs no secret storage and no code path that reads or passes credentials.
- Setting up a gateway happens in the provider's settings, outside the app.
- Remote host components, once they exist, sign providers in on the remote host with the providers' own tools.
- The planned check for invariant 9 also covers remote host modules and gateway settings.

## Revisit when

A provider offers no way to configure a gateway in its own settings, and users need that gateway.
