---
id: ADR-0020
type: adr
title: Follow each provider's own default for its task tools
status: accepted
visibility: public
date: 2026-11-05
summary: The app turns on no provider's task tools and shows a session's task list wherever the provider's agent keeps one, since Claude Code now offers its task tools by default only to its older models and Codex keeps its plan tool off, and turning them on for every session would spend tool calls in every multi-step turn and move the agents off their makers' defaults; turning them on for every session and a setting of the app's own were rejected
scope: ["src/providers/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

A session's task list in the app is the list its agent keeps through the provider's own tools: Claude Code's TodoWrite, TaskCreate and TaskUpdate, Codex's plan tool (`update_plan`), and the plan Grok Build sends over ACP. Each adapter turns it into the session's task list, which the activity shows.

The providers have stopped offering those tools by default. Claude Code 2.1.233 stopped offering its task tools to its newest models, and since 2.1.268 offers them by default only to Claude 3, Opus 4.0 to 4.7, Sonnet 4.0 to 4.6 and Haiku 4.5. The Claude Agent SDK's documentation says that newer models track multi-step work without a written list, and that an application should turn the tools on only when it reads their calls, to log task activity or to render its own progress display. Codex 0.152.0 made its plan tool opt-in, taking its planning guidance out of its prompts too, and gave no reason. Grok Build still sends its plan. On those defaults, a session on Claude Code's newer models or on Codex shows no task list.

## Options

- Follow each provider's own default (chosen): the app passes nothing that turns a task tool on, and a session shows a task list wherever its agent keeps one: on Grok Build, on Claude Code's older models, and on Claude Code or Codex once the user turns the tools on in the provider's own settings, `CLAUDE_CODE_ENABLE_TODO_TOOLS` in the `env` of Claude Code's `settings.json`, which every session reads, or `tools.update_plan.enabled = true` in Codex's `config.toml`.
- Turn the tools on for every session, with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in Claude Code's environment and `-c tools.update_plan.enabled=true` on Codex's app-server: every session would show a task list, and the app does render progress, which is when Anthropic advises turning them on. But every multi-step turn would spend tool calls on keeping the list, whether or not the user looks at it, and the agents would run off the defaults their makers tune them for, Codex's planning guidance back in its prompts.
- A setting of the app's own that turns them on: it repeats a choice each provider already offers in its own settings, where the user makes it once for the app and the provider's own tools alike, and gives that choice a second place to be kept.

## Decision

The app turns on no provider's task tools. A session's task list stays the list its agent keeps, shown wherever the provider sends one, and the providers' docs (`docs/providers.md` and the Claude Code and Codex adapters' READMEs) name each provider's own setting for turning the tools on.

## Consequences

- Easier: sessions behave as they do in the providers' own tools and spend no tool calls on lists the agents do without; a provider that changes its default changes nothing in the app.
- Harder: on the providers' current defaults, a session on Claude Code's newer models or on Codex shows its progress only in its activity, without a task list, unless the user turns the tools on.
- Must stay true: the app passes no setting that turns a provider's task tools on or off, and the task list shows whatever list a provider sends.

## Revisit when

A provider changes its default again, or offers a way to follow its agent's progress that costs no tool calls.
