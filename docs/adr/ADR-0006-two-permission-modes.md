---
id: ADR-0006
type: adr
title: Offer two permission modes, automatic approval by default and yolo
status: accepted
visibility: public
date: 2026-10-26
summary: Every provider runs in one of two modes, auto, in which the provider's own automatic review approves or denies each action and asks the user only when it cannot decide, and which new sessions start in, or yolo, in which nothing is asked; asking before every action and the providers' other modes are not offered
scope: ["src/sessions/**", "src/providers/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

ADR-0003 expected sessions to start in each provider's ask mode, and the first session model listed each provider's own modes. The maintainer decided on 2026-10-26 to offer only two modes for every provider: automatic approval, as the default, and no approval prompts at all ("yolo").

All three providers have both natively. Claude Code has its auto mode, in which a classifier approves or denies each call and prompts through `canUseTool` when it cannot decide, and `bypassPermissions`. Codex has on-request approvals with its automatic reviewer, and an approval policy of `never`. Grok Build has auto and yolo modes. The Codex and Grok Build mappings are confirmed when their adapters are built.

## Options

- Two modes for every provider, `auto` by default and `yolo` (chosen): one switch that means the same for every provider, and turns that rarely stop for the user.
- Each provider's own modes, starting in ask mode (the first design): the most control, but every action waits for the user, and the modes differ from provider to provider.
- Ask mode by default, with `auto` and `yolo` to choose: a more cautious default, but it is not the flow the maintainer wants.

## Decision

The session model has one `PermissionMode`, `auto` or `yolo`; each adapter maps it to its provider's native mode. New sessions start in `auto`, and a session can switch mode while it runs. Approvals still reach the user whenever a provider's automatic review cannot decide, and questions always do. Choosing `yolo` for a session needs the user's confirmation in the UI. This replaces ADR-0003's expectation that sessions start in ask mode; ADR-0003's choice of protocols stands.

## Consequences

- Easier: one mode switch for every provider; fewer interruptions.
- Harder: actions run without the user's review whenever a provider's automatic review approves them, so safety rests on that review, and in `yolo` on the user's choice alone. Claude Code sessions start with skipping permissions allowed, so that they can switch to `yolo` without a restart.
- Must stay true: new sessions start in `auto`; `yolo` is only ever entered by the user's choice.

## Revisit when

A provider drops its automatic review or changes what it approves, or the user finds that automatic approval lets through actions they would have refused.
