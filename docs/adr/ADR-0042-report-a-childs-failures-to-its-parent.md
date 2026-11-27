---
id: ADR-0042
type: adr
title: Report a child's failures and stops to its parent as notices of the app's own in the parent's inbox
status: accepted
visibility: public
date: 2026-11-26
summary: When a child's turn fails or the user interrupts it, or the child stops without its parent or itself ending it, the host puts a report of the app's own, marked by the notice's report field and sent under the child's id, into the parent's inbox, where it reaches the parent as message notices do, an idle parent included; reports through session_list, a tool that reads a child's conversation, and a report at every turn's end were rejected
scope: ["src/sessions/**", "src/toolset/**", "src/providers/**", "src/i18n/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

A child reports to its parent only through `message_send` (ADR-0036), and a child that fails sends nothing. `session_list` gives a child's status alone: a turn that ended in an error leaves it idle like a finished one, and a provider that stopped leaves it closed like a child that was ended. A parent that is idle never polls; only a notice wakes it, in a turn the host starts for the notice alone.

The host already sees what a parent would need to hear: a turn's end carries its outcome, `completed`, `interrupted` or `failed`, with the provider's error for a failed one, and a session's `closed` event carries the provider's error where its process stopped on its own. The host also knows which closes it starts itself: a child ended by its parent or by itself, sessions archived or removed with their parent, every session as the app quits.

## Options

- How the parent learns:
  - A report in the parent's inbox, through ADR-0036's notice paths (chosen): it reaches an idle parent in a turn of its own, waits for a parent that is not running, survives a restart, and adds no tool and no concept beyond a marker on a notice.
  - A field of `session_list`: a parent that is idle never asks for it.
  - A tool that reads a child's conversation or last message: a parent would have to ask too, and would take far more context than a report needs.
  - A report at every turn's end: it would wake the parent for turns that need nothing from it, while a child that finished reports through its brief.
- Whom the report comes from: the child's id and title, in the notice's `from` and `fromTitle`, with a `report` field that says what the app saw (chosen), so that the inbox's lists, deliveries and the providers' histories carry it as they carry messages, and the block's instruction tells agents that such a notice is the app's report, not the child's message. A sender of the app's own would leave a parent without the child's id where it needs it.
- Which events: a turn that ends `failed`, with the provider's error; a turn that ends `interrupted`, which only the user causes; a close the host did not start, with the provider's error where it gives one; and the user's archiving or removing the child (chosen). The host's own closes, of a child its parent or itself ended, of a child archived or removed with its parent, and of every session as the app quits, give none, nor does an interruption on the way to one of them.

## Decision

`InboxNotice.report`, `failed`, `interrupted` or `stopped`, marks a notice that the host wrote about the session it names, the parent's child, rather than a message that session sent. As a child's turn ends `failed` or `interrupted`, and as a child closes without the host having started the close, or because the user archived or removed it, the host puts a report into the parent's inbox: a summary that names the child and gives what happened and the reason, cut to a message summary's length, the reason in full as its body, and the child's id and title as its sender. It then tells the parent as it tells a receiver of a message: at once in a turn of its own where the parent is idle, and otherwise at the next fitting moment. The host notes, before it closes a session itself, why it does, which keeps its own closes and the interruptions on the way to them from giving reports.

The block's instruction says that a notice with `report` is the app's report on one of the agent's child sessions; `inboxNoticesOf` reads the field back from a history; the inbox keeps it with the message; `message_read` calls such a message the app's report on the child; and the activity shows it as the app's report on the child, beside the messages from other sessions.

## Consequences

- A parent hears of a child that will not report, the moment the app sees it, idle or not, and can message the child, end it or start another.
- Reports count against an inbox's limits as messages do, and those read leave first.
- A child whose turns fail one after another gives a report for each.
- Children closed by the app quitting give none; after a restart `session_list` shows them closed.

## Revisit when

- Agents need to hear of their children's turns that end normally, or of children that wait on the user.
