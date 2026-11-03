---
id: ADR-0013
type: adr
title: Draw the main process's menus and questions in the window's page, in the app's own look
status: accepted
visibility: public
date: 2026-11-02
summary: The main process keeps deciding what it asks the user, but its context menus and confirmation questions go to the window's page as plain data, which draws them with the ui module's menu and question in the e-ink look and sends back the answer; macOS's menus and sheets, which cannot take that look, flows driven from the page and a window of its own per question were rejected, and the file panels and the question while a page unloads stay macOS's own
scope: ["src/ui/**", "src/app/**", "src/sessions/main/native.ts", "src/workspaces/main/native.ts", "src/files/main/native.ts"]
tags: []
supersedes: []
superseded_by:
---

## Context

The window takes an e-ink look: the window's paper with its grain, ink, and dashed lines around sheets, the selects' lists among them. The context menus (a session's, an image's and a workspace's) and the confirmation questions (before yolo, before archiving a session that is working, before removing one, the trust question for a new workspace, and before a panel with unsaved changes closes) were macOS's own, which follow the system's appearance but cannot take that look. The maintainer asked for them to match the rest of the window.

The main process drives these flows: a session's menu, then its confirmation, then the action; a folder picked, then its trust question; a switch to yolo, confirmed before it takes. Each feature module's main-process code asks through an interface of its own (`SessionsUi`, `WorkspacesUi`, `FilesUi`), and the confirmations default to the safe answer, Cancel, so that Return never confirms by accident. ADR-0006 requires the user's confirmation before yolo.

## Options

- Prompts drawn by the page (chosen): the main process sends a menu or a question, as plain data with an id, to the window's page, which draws it with the ui module's components and sends back the answer over the bridge. The flows, their contents and their defaults stay in the feature modules' main-process code, which asks through one interface, `Prompts`.
- macOS's menus and sheets (the first design): the system's keyboard handling, VoiceOver support and placement for free, and menus that may reach beyond the window; but they cannot take the e-ink look.
- Flows driven from the page: the page shows each menu itself and asks each question before it calls the bridge, so that a menu opens without a round trip to the main process; but every flow and its bridge calls change, and the questions move out of the modules that own the actions.
- A window of its own per question, a modal child window that macOS hangs from the main window as a sheet, with a page of its own: the main window's page could never answer a question; but each question needs a second page, preload script and window, within macOS's sheet frame, for answers the main page already gives for a new or resumed session's settings.

## Decision

The app module implements the ui module's `Prompts` for each window (`windowPrompts`): a prompt goes to the window's page with an id of its own, and only an answer the prompt offers, from the page it was sent to, resolves it; while the window is gone, or once its page goes or loads anew, a menu resolves with no choice and a question with its cancel answer. The page draws one prompt at a time, a menu as the ui module's `Menu`, where the pointer or the keyboard last asked for one, and a question as its `QuestionDialog`, a modal dialog with the focus on the default answer. The feature modules ask through `Prompts` with the same contents and defaults as before. The page is trusted with the answers, as it already is with the yolo it chooses for a new or resumed session; the text it shows is data, rendered as text, never as markup.

The folder picker, the save panel and the question before a window whose editors hold unsaved changes closes stay macOS's own: the panels give the file system's own look and abilities, and a page cannot draw while it unloads.

## Consequences

- Easier: the menus and questions look like the rest of the window in both themes; the flows are unchanged; what each module asks is tested without Electron, against fake prompts.
- Harder: the menus' keyboard and VoiceOver behaviour, and when they close, are the app's to keep (the arrow keys, Home, End, letters, Escape, the menu roles, and a press beside a menu but not the release of the press that opened it, L-0002), where macOS gave them; a menu stays inside the window, opening above or to the left of its point near the window's edges; each prompt takes a round trip to the page.
- Must stay true: every question has a cancel answer, which a page that goes gives; the main process takes only answers its prompt offers, from the page it asked; the confirmations keep their safe defaults; prompts carry text, which the page shows as text.

## Revisit when

Electron or Chromium can draw its native menus and sheets in a page's own styles, or VoiceOver users find the drawn menus harder to use than macOS's.
