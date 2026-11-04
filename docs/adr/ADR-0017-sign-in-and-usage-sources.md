---
id: ADR-0017
type: adr
title: Read each provider's sign-in and usage limits through its adapter, from the calls each provider offers, and ask rarely
status: accepted
visibility: public
date: 2026-11-04
summary: Each adapter reads its provider's sign-in and a subscription's usage limits, through a running session's process where one is open and otherwise a short-lived one, from Claude Code's sign-in status and experimental usage call, Codex's app-server account calls and Grok Build's undocumented `x.ai/auth/info` and `x.ai/billing`, with the limits that turns report on their own; the app asks once after the window opens, then only when the Accounts panel shows data over five minutes old, every five minutes while it shows, after a reset or a sign-in, and keeps the limits it read in its data; calling the providers' web endpoints, parsing their commands' text and polling were rejected
scope: ["src/accounts/**", "src/providers/**", "src/app/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

The app shows whether each provider is signed in, and how, and for a subscription its usage limits and when they reset, with Codex's own reset of its limits; never the account's email. The providers offer this in different ways, some of them experimental or undocumented, and change between releases. Invariant 9 keeps every credential in the providers' own tools, so the app cannot ask the providers' web services itself. Each request for the usage reaches the provider's servers, so the app asks rarely and shows what it last read in the meantime, after a restart too.

## Options

- Where the calls live: in each adapter, behind an interface the accounts module declares (chosen), so that a provider's experimental or undocumented calls, and their changes, stay in one adapter; or an accounts client per provider beside the adapters, which would start and speak to the providers' processes a second time.
- Claude Code: its own `claude auth status` for the sign-in, which reads Claude Code's settings without a model call, and for the usage the SDK's experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` with `skipBehaviors`, which lists the plan's windows, five-hour, weekly and per model, with their use in percent and their reset times, together with the `rate_limit_event` messages each turn brings, whose use is a fraction (chosen). The experimental call may answer with no windows, as Claude Code 0.3.310 does when the usage endpoint refuses the sign-in it holds, so the events stay the fallback. Rejected: Anthropic's usage endpoint called by the app, which needs Claude Code's credential; the text of `claude auth status`, when it answers in JSON; the account info in the SDK's initialize answer, which carries the email and from which an API-key sign-in is told only by a field the app's code never names.
- Codex: the app-server's `account/read`, `account/rateLimits/read`, its `account/rateLimits/updated` notifications during turns, and `account/rateLimitResetCredit/consume` (chosen); rejected: `codex login status`, whose text says less.
- Grok Build: its agent mode's undocumented `x.ai/auth/info`, which answers from Grok's own settings, and `x.ai/billing`, which reads the plan's current period, its start and end, and, where the plan has included credits, how much of them is used (chosen); rejected: `grok usage`, a session's own tokens and cost, and anything read from Grok's text interface.
- How often: once in the background shortly after the window opens, then only when it is worth it, with what was read kept in memory and the usage also in the app's data (chosen); rejected: reading on a timer whatever shows, which asks the providers all day, and reading only when the Accounts panel opens, which leaves the panel empty and the session pages' notice silent until then.

## Decision

The accounts module declares the interface each adapter implements beside the sessions interface: read the sign-in, read it with the usage, give the provider's sign-in command, hear what turns report, and, for Codex, spend a reset. Each adapter answers through a process it already runs for a session where one is open, and otherwise through a short-lived one, as its model list is read.

- A sign-in is signed out, signed in with a subscription, with an API key or through another backend, or unknown when the provider could not say. Claude Code is signed in through another backend when its API provider is not Anthropic's own, with a subscription when it names one, and otherwise with a key; Codex with a subscription for a ChatGPT account, through another backend for Amazon Bedrock, and otherwise with a key; Grok Build with a subscription when it holds the token its own sign-in stores, otherwise with a key, and signed out when it names no sign-in. The app's code never names an API key (invariant 9's check), so a key is what remains once the other ways are ruled out. A call that fails or answers in another shape leaves the sign-in unknown or the usage unread, never wrong.
- A usage window has its span (five hours, a day, a week, a month, or a number of minutes), the models it is for where it is for some alone, how much is used in percent, or nothing where the provider gives the window's reset but not its use, and when it resets. Claude Code's experimental windows and Codex's primary and secondary windows map onto it, and so does Grok Build's current period, with the share of its credits used where the answer has one. Codex also says how many resets it holds. Extra usage, credits, top-ups and pay-as-you-go stay out. A read that cannot give a subscription's usage says why, in a few words the panel shows: the provider could not fetch it for the sign-in it holds, as when a request is refused or Claude Code's experimental call answers without windows; the app could not ask the provider; or the answer had another shape.
- The app reads every provider once, one at a time, shortly after the window opens. It reads a provider's usage again when the Accounts panel shows and what it holds is more than five minutes old, every five minutes while the panel shows, and after a reset; it reads the sign-in again after a turn fails for want of one, and when a sign-in command ends, with the usage if the provider is then signed in with a subscription. Claude Code's rate-limit events and Codex's rate-limit updates change the usage without a request. Nothing else asks: the session pages' notice shows what the app holds.
- `accounts.json` in the app's data keeps each provider's windows and resets with when they were read, and nothing else of the account; the sign-in is read anew in each run.

## Consequences

- Easier: one panel for every provider, and a notice that costs no requests.
- Harder: the experimental and undocumented calls may change in any release of a provider, which an upgrade must check; until a turn reports them, a Claude Code whose experimental call answers without windows shows only why it has none.
- Must stay true: an adapter alone knows its provider's account calls; the app never calls a provider's web services itself; the kept usage holds no credential and nothing of the account but its limits and their reset times; no request is made on a timer while the Accounts panel is not shown.

## Revisit when

A provider documents its usage, or changes or removes the calls above; or Codex's resets, or another provider's own reset, change how they are spent.
