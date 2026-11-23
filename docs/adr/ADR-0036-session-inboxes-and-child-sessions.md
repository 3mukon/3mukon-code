---
id: ADR-0036
type: adr
title: Coordinate sessions through inboxes whose notices travel like presentation notices, and through child sessions, with five tools of the app's toolset
status: accepted
visibility: public
date: 2026-11-23
summary: Each session has an inbox the host keeps in the app's data; a message's summary reaches the receiving agent with its next call to the app's tools, beside the user's next message or, while it is idle, in a turn the app starts for the notice alone, and its body only through a tool; sessions list sessions, start children of any provider that start none of their own, end their children and exchange messages through five tools beside the automation tools; messages as user messages, teams and roles, a message queue with delivery workers, a shared task list and native subagents alone were rejected
scope: ["src/sessions/**", "src/toolset/**", "src/providers/**", "src/app/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

Agents in different sessions, on any provider, should be able to work together: an agent hands part of its work to a child session and hears back from it, and any session can tell another something. The providers' native subagents run inside one provider's process, out of the Sessions list's sight, and neither another provider nor another session can reach them. An earlier design sent agents' messages as user messages, which neither the receiving agent nor the user could tell from the user's own and which arrived unreliably, beside teams, a message queue, hand-off and task tools that overlapped.

The app already tells agents of the user's changes to the panels they presented, as notices that travel beside the user's next message and with the result of the agent's next call to the app's tools, retired only once delivered (ADR-0026, DOC-automation-contracts).

## Options

- How a message reaches its receiver:
  - Into the receiving session's inbox, from which a notice with each new message's sender and summary reaches the agent at the next fitting moment, while the body waits for a tool (chosen): the agent learns of a message without its context filling with bodies it may not need, and the user and the agent can tell the notice from the user's message.
  - As a user message in the receiving session: indistinguishable from what the user typed, and delivered only as a turn can take it.
  - Only when the agent asks, by polling a tool: an idle agent never learns of a message, and a working one spends calls on polling.
- When a notice reaches the agent:
  - With the result of its next call to any of the app's tools during a turn, beside the user's next message, and, while the session is idle, in a turn the app starts for the notice alone, as soon as the message comes and as a turn ends with messages untold (chosen): the first two are where presentation notices travel, and the third lets a message reach an agent that waits for no user, such as a parent whose child reports back. A session that waits on the user, with an approval or a question open, or is not running, is told at the next of these moments.
  - The first two alone, as presentation notices: an idle parent would never hear from its children until the user wrote.
- What carries the work:
  - Child sessions that the app starts and lists like any session, beneath their parent, in the parent's folder, in auto and with no wider a sandbox than the parent's, of any provider, model and effort, which start no children of their own and which their parent or they themselves end (chosen): each child's work, approvals and history stay visible and answerable in the app, and depth stays one.
  - Teams with leads and members, and a shared task list: more concepts than the work needs; a task list is left to a later change.
  - Native subagents alone: they stay within one provider and out of the user's sight.
- Which tools:
  - Five, `session_list`, `session_start`, `session_end`, `message_send` and `message_read`, served by the toolset beside the automation tools and outside the automation broker, since they act on the app's sessions rather than on a browser or another application, and called with the calling session's own id from its bound access (chosen). A child is not offered `session_start`, and the app refuses one from it all the same.
  - Tools per concept of the earlier design, about twenty: overlapping and hard to reason about.
- Where inboxes live: in the host, with each message, whether its agent was told of it and whether it read the body, saved in `session-inbox.json` in the app's data, and which session is whose child in the session records (chosen), so that both survive a restart.

## Decision

The sessions module's host keeps every session's inbox (`SessionInboxes`) and each child's parent, and implements `SessionCoordinator`, which the toolset's session tools call with the owner of the calling access. A message has a summary of at most 300 characters and a body of at most 64 KiB; an inbox keeps its newest 500 messages, those read leaving first, and a notice names at most 20. The notices travel as a block of the app's own (`3mukon-code:inbox`) in the host turn context beside the user's text, in each adapter's own form for host context, and as an `inbox` field in the app's tools' results; the host marks them told once the provider takes the context or the result goes, and shows them in the session's activity as an entry of the app's. While a session is idle, the host starts a turn with the host context alone (`ProviderSession.deliverContext`), which shows no message of the user's. The providers' histories give the blocks back as the same entries. A child's first message, its task, shows in its activity as its parent's. Archiving, unarchiving or removing a parent does the same to its children, asking first where any of them works; at most eight of a parent's children run at once.

## Consequences

- Agents of any provider can hand work to children and hear back without the user relaying it, and the user sees each child, its approvals and its messages in the app.
- Messages are data from other agents: the notice says so to the receiving agent, and no agent approves or widens another's permissions.
- The notices of new messages reach the agent once, by their summaries; an agent that needs a body reads it, so a message costs its body's context only where it matters.
- Notices that went with a tool's result show in the activity as the host gives them, but after a restart only within that tool call's output; those that went with a turn show again from the provider's history.
- Two agents can keep messaging each other; the app does not police their conversation beyond the limits above, and the user can stop either session.

## Revisit when

- Agents need a shared task list, children of their own children, or sessions on remote hosts.
- A provider offers a way to deliver context into a running turn at a moment of the app's choosing.
