---
id: DOC-mod-approvals
type: doc
title: approvals module
status: current
visibility: public
date: 2026-10-30
summary: The sessions' approvals and questions as the user answers them, in place in the activity and collapsed to an entry once answered, the waiting indicator that shows the session that has waited longest, and the Dock icon's count of sessions waiting
scope: ["src/approvals/**"]
tags: []
---

## Responsibilities

- Requests in the activity (`renderer/requests.tsx`): `Request` shows one approval or question where it stands in a session's activity, as the session page hands it over.
  - While it waits, a block, as the reference's question block. `ApprovalBlock` says what the agent wants to do in the window's language, with the provider's own wording and the agent's reason under it, then the command and its folder, the files and the change, or the plan; it offers Allow Once, Allow for This Session where the provider can remember it, and Deny, the default drawn in ink, Deny where the provider asks for it to be; where the provider passes a denial's message on to the agent (`denialMessage`, Claude Code's), a field under the buttons takes one, which Deny sends. `QuestionBlock` shows each question's choices, toggles where it takes several, and a field for an answer of the user's own where the agent takes one, masked for a secret; a single question of one choice is answered by its button, others with Answer once every question has an answer, and Skip declines. An answer that could not be sent says so.
  - The keyboard, while a block has the focus, which the waiting indicator and ⇧⌘A give it, with the keys shown faintly on the buttons meanwhile, which widens them, so that a button takes the focus with its click rather than its press (L-0011): in an approval, Return gives the default answer, ⌥Return allows for the session, unless the provider wants no approval from one key, and Escape denies; in a question, 1 to 9 choose by number, Return answers and Escape skips. In a field, Return denies with the message or answers, and Escape leaves the field; a focused button keeps its own Return and Space. Typing elsewhere, as in the composer, answers nothing.
  - Once answered or withdrawn, an entry like a tool call's, collapsed: what was asked and what came of it, such as Allowed once, Denied, Answered, Skipped or Withdrawn. Opened, it shows the request, and the answer: the message a denial sent, or each question's choices with those the user made marked and what they typed, a secret's text hidden.
- Operations' approvals that the app asks for its own tools (`renderer/host-approval.tsx`, ADR-0027). `HostApprovalBlock` is the waiting block. It asks in the window's language what the agent wants to work on, by the operation's kind and target: a page in Chrome, signed in as the user, or in the app's browser; an application to observe and operate in the background, or with the keyboard and pointer in the foreground; or a dialog an application opened. Under the question it says what that means, as the sign-ins of the named Chrome profile in a tab the agent opens, where it may run scripts that read what the page can, and how long each answer lasts, and whether the target may come to the front by itself. The block answers as a provider's approval does, with Allow for This Session always offered and a denial's message always reaching the agent; both share `AnswerBlock` from `renderer/requests.tsx`. `AnsweredHostApproval` is the line an answered approval keeps in the activity before the call that asked: the question, how it was answered, a denial with its message, and once its grant has ended, when and why, such as ended as the turn ended or ended by you; a grant still in force has End, which ends it at once.
- The answers' way to the main process (`shared/approvals.ts`): `ApprovalsBridge`, what the window asks of the approvals through the preload bridge, an approval's or a question's answer by the app's id for the session and the request's id.
- The waiting indicator (`renderer/waiting-button.tsx`): `WaitingButton` counts the sessions waiting on the user, an operation's approval included, as the sessions module's summaries count it, as the ui module's waiting indicator, and shows the one that has waited longest (`shared/waiting.ts`, by each session's oldest open request). `nextWaiting` gives the session ⇧⌘A shows next: the one after the focused session in the order they have waited, or else the one waiting longest.
- The Dock (`main/dock.ts`): `dockAttention` shows the count of sessions waiting as the Dock icon's badge, and bounces the icon once when one more starts waiting while no window of the app has focus.

## Not responsible for

- Holding the requests and passing answers to the providers: the sessions module folds the requests into each session's state, records the answer the user gave, and its host passes answers to the provider's session.
- Where the indicator and the requests show: the app module puts the waiting button beside the window buttons, just after the archived sessions' button, and hands the session pages this module's request view, with what answers it.
- The look of the indicator, the icons and the tokens, which the ui module holds.

## Interface

- For the app module: `Request`, which takes a key that gives it the focus, and `Answering` from `renderer/requests.tsx`, `HostApprovalBlock`, `AnsweredHostApproval` and `GrantStanding` from `renderer/host-approval.tsx`, `WaitingButton` from `renderer/waiting-button.tsx`, and `dockAttention` with `Dock` from `main/dock.ts`.
- For both processes: `ApprovalsBridge` in `shared/approvals.ts`, and `waitingSessions` and `nextWaiting` in `shared/waiting.ts`.

## Dependencies

- Uses the sessions module's model (`src/sessions/shared/`) and its activity's views (`src/sessions/renderer/`: the diff view, Markdown and the entry line), the ui and i18n modules, React and react-i18next. The rule `approvals-only-to-sessions-ui-and-i18n` in `.dependency-cruiser.js` enforces it, and the sessions module's own rule keeps it from using this module.
- Only the app module imports it.

## Invariants

- An answer reaches the main process only through `ApprovalsBridge`, and a secret's typed text is never shown again once sent.
- The blocks and entries are rendered with answers given by the test (`renderer/requests.test.tsx`); the waiting count and the Dock badge have unit tests (`shared/waiting.test.ts`, `main/dock.test.ts`); a smoke test answers an approval in the built app through to the main process, after the waiting indicator shows its session (`tests/smoke/sessions.spec.ts`).
