---
id: ADR-0041
type: adr
title: Let agents list each provider's models through a sixth session tool, provider_list, and refuse a child a model or effort its provider does not list
status: accepted
visibility: public
date: 2026-11-26
summary: An agent that may start children lists, through provider_list, the models each provider offers a child of its own, from the lists the new-session page uses, and session_start refuses before a child starts a model the child's provider does not list, or an effort its model does not take, naming what to use instead; choosing a provider from the model, putting the lists into the tools' descriptions, and leaving a mismatch to the provider were rejected
scope: ["src/toolset/**", "src/sessions/**", "src/i18n/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

ADR-0036 gave agents five session tools, among them `session_start`, which takes a child's provider, model and reasoning effort. Its description says, for every provider, who makes the models it runs and their family, but not which models, by their exact ids, or which effort levels a provider offers on the user's accounts: those change with the accounts and with each provider's releases, and some providers offer other makers' models besides their own. The host passed a child's model and effort to the provider unchecked. Codex, for one, sends the model's name with the thread it starts, so a wrong pairing surfaced only as the child's first turn failing, after the parent had been told that the child started.

The host already keeps each provider's models for the new-session page (`SessionHost.models`): found by the provider's probes without starting a session, for a folder and a gateway, a list found within the last 15 seconds or a new one when the page asks before its first message, and at most a minute per listing.

## Options

- How an agent learns the models:
  - A sixth session tool, `provider_list`, offered where `session_start` is, which lists each provider's models as a child of the caller would get them (chosen): the exact ids and effort levels come from the providers' own lists, the ones the new-session page shows the user, and listing costs only the agents that ask.
  - The lists in `session_start`'s description: the toolset builds its tools' descriptions once and every session receives them on every turn, so every session's start would list every provider's models, Antigravity's by starting a process, and every turn would carry them, for sessions that never start a child too; they would also go stale as accounts change.
  - A field of `session_list`'s results: it mixes the providers into the sessions, and would list models on a call agents make far more often.
  - The host choosing a child's provider from its model where the agent names none: it guesses on the agent's behalf against the stated default, the caller's own provider, and cannot decide where two providers list the same model, as Antigravity lists other makers' models.
- Where a child's model is checked:
  - In the host, as it starts the child, against the list of the child's provider (chosen): the host keeps the lists and decides what a child takes when the agent leaves a choice out.
  - In the toolset: it has neither the lists nor the defaults a child takes.
  - Nowhere, leaving it to the provider: a mismatch shows late, in the child, after the parent was told the child started.
- What matches: a model's id exactly as the provider lists it (chosen), as the new-session page offers only listed models; accepting names a provider takes without listing them, such as a full id where it lists an alias, would need knowledge of each provider's names that its list does not give, and the refusal lists the ids to use instead.
- Where the child's provider cannot list its models in time, or lists none: the child starts as it did before the check, and the provider decides (chosen); refusing would keep a child from a provider that might well take the model, and an empty list says more of the listing than of the provider's models.

## Decision

`SessionCoordinator.providers` gives, for every provider the app has, the models a child of the calling session would get: `SessionHost.models` for the caller's folder, through the caller's gateway for its own provider and through each other provider's own configuration, a list found within the last 15 seconds or a new one, as the new-session page asks for; a provider whose listing fails or does not answer within a minute gives its reason instead, and the others their lists. The toolset's `provider_list`, offered only to a session that may start children, returns them, as text with each model's id, name, effort levels and the defaults, and as structured content; `session_start`'s description points to it.

As `SessionHost` starts a child (ADR-0036), it checks a model the agent named against the list of the child's provider, and an effort the agent named against the levels of the model the child will run: the model named, otherwise the caller's where the child has the caller's provider, otherwise the provider's default. A model not on the list is refused, and no child starts, with the models that provider offers and the providers whose lists hold the model asked for; an effort the model does not take is refused with the levels it takes. A model or effort left out is not checked, and a list that cannot be had, or that holds no model, leaves the start as it was.

## Consequences

- An agent finds which provider offers a model, and the ids and levels to give, in one call, and a wrong pairing is refused at once with what to use instead, rather than failing later in the child.
- The toolset serves six session tools; a child is offered neither `session_start` nor `provider_list`.
- A child started with a model or effort waits for its provider's list where none was found within 15 seconds, at most a minute; a refused model also lists the other providers' models, to name those that hold it.
- A name a provider would take without listing it is refused.
- The check is as current as the provider's own list: a model the provider lists but the account cannot use still fails in the child.

## Revisit when

- A provider offers a way to check a model without listing its models.
- A child on another provider than its parent's should run through a gateway of its own.
