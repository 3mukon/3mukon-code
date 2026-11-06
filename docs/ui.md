---
id: DOC-ui
type: doc
title: The window, its panels, keys and look
status: current
visibility: public
date: 2026-11-04
summary: One window holds a sidebar of workspaces and sessions beside a main area of panels that split, move and close, with the title bar's buttons for archived sessions, accounts, settings and waiting sessions; it is drawn in an e-ink look in light and dark, in English or Simplified Chinese, shows the main process's menus and questions in its own page, and works from the keyboard as well as the pointer
scope: ["src/*/renderer/**", "src/app/main/window.ts", "src/app/main/prompts.ts", "src/ui/shared/**"]
tags: []
supersedes: []
superseded_by:
---

The app has one main window, built from the feature modules' renderer parts and composed by the app module. This page is the map: what the window shows, where, and which module owns each part. The module READMEs hold the details; the ADRs and lessons cited give the reasons.

## The window

- **Title bar**: the window's top 40 pixels, which move the window and show no title. macOS's window buttons sit in it, and just after them, wherever they lie, the archived sessions' button, the accounts' gauge, the settings' gear and, while any session waits on the user, the count of waiting sessions. Over the main area, the title bar holds the headers of the panels at the top. (DOC-mod-app)
- **Sidebar**, 220 pixels wide, which ⌘B hides and shows: the app's name; the Workspaces section, with Add workspace and the workspaces as a tree of their folders and files (DOC-mod-workspaces); then the Sessions section, with New session, a filter by workspace and a search by title and conversation, and the sessions not archived, the most recently active first (DOC-mod-sessions).
- **Main area**: the panel area, empty until something opens in it (DOC-mod-panels).
- The page itself never scrolls; each pane and list scrolls within itself (L-0001). The paper's grain lies behind the content, including on filled surfaces (L-0009). (DOC-mod-ui)

## Panels

Each panel is a pane with a header, which can lie in the title bar, holding its title, a detail such as its folder's name, its status, actions and a close button. The focused panel is marked current and the others dim.

| Panel | Shows | Module |
|---|---|---|
| Session page | A new session's settings and composer; once its first message is sent, the session itself | DOC-mod-sessions |
| Session | A session's activity, its approvals and questions in place, its settings and composer | DOC-mod-sessions, DOC-mod-approvals |
| File | A file rendered in its format, or its raw text in the editor, with a toggle between them at the header's end (ADR-0011, ADR-0018) | DOC-mod-files |
| Terminal | The user's login shell in a folder, or a provider's sign-in command (ADR-0015, ADR-0016) | DOC-mod-terminal |
| Archived sessions | The archived sessions, searchable, each unarchived or removed from its row | DOC-mod-sessions |
| Accounts | Each provider's sign-in and its subscription's usage limits (ADR-0017) | DOC-mod-accounts |
| Settings | The language and the appearance | DOC-mod-settings |

- **Opening**: a click on a session shows it; New session opens a session page in the selected workspace's folder; a row of a tree or list dragged into the area opens there, filling it, beside a panel near its edge, or in its place in its middle, as do files and folders dragged from the Finder. The archived sessions', accounts' and settings' panels show once each; opening one again focuses it.
- **Arranging**: a panel's title drags it beside another or swaps the two; the dividers between panels drag, or take focus and move with the arrow keys. The app's own drags use the pointer's own events, never a drag of the system's (L-0003).
- **Closing**: a panel with unsaved changes asks first, and so does a terminal while a program other than the shell runs in it.

## Keys

| Keys | What they do |
|---|---|
| ⌘B | Hide or show the sidebar |
| ⌘, | Open the settings |
| ⇧⌘A | Show the session that has waited longest on the user, then the next at each press |
| ⌃` | Open a terminal beside the focused panel, in its folder |
| ⌘D, ⇧⌘D | Split the focused panel to the right or downwards, with a session page in its folder |
| ⌘W | Close the focused panel |
| ⌘1 to ⌘9 | Focus the panels in reading order |
| ⌥⌘ and an arrow | Focus the next panel that way |
| ⇧⌥⌘ and an arrow | Swap the focused panel with the next one that way |
| ⌘↓ | Open the focused row of a workspace's tree in the panel area |
| ⌘S | Save the file in the focused panel |
| Return, ⇧Return | Send a message; start a new line in it |
| Return, ⌥Return, Escape | In an approval: give its default answer, allow for the session, deny |
| 1 to 9, Return, Escape | In a question: choose by number, answer, skip |

The workspaces' tree moves as macOS lists do, with the arrow keys, Home and End.

## Menus and questions

The main process's menus and questions show in the page, in the app's own look, one at a time in the order asked (ADR-0013): a menu at the pointer, such as a workspace's, a folder's or a session's, and a question over the window, such as the trust question when a workspace is added or a confirmation before something ends or goes. The folder picker, the save panel and the question before a window with unsaved changes closes stay macOS's own. (DOC-mod-app, DOC-mod-ui)

## Look

- An e-ink look after the Ink Paper theme on the Flexoki palette: ink on a warm grey paper in light appearance and pale ink on dark paper in dark, with a faint grain on the paper, sheets drawn as the paper itself under a dashed line and no shadows. Colour is kept for what it means: states, additions and deletions, warnings and the accent. (DOC-mod-ui)
- The appearance follows the Appearance setting: System, which follows macOS, Light or Dark.
- The system's fonts, SF Pro and SF Mono, and Lucide's icons (ADR-0007).
- Messages and Markdown files render with the same renderer, with math and highlighted code (ADR-0010, ADR-0018).

## Language

The window and the main process's menus and questions are in English or Simplified Chinese, following the Language setting: System, which takes macOS's preferred languages, English or 简体中文. Every string exists in both catalogs. Names that come from the providers or their files stay as they are in either language: models, gateways and reasoning effort levels, the levels with a capital first letter as the other settings have. (DOC-mod-i18n)

## Access

- The lists, the trees, the dividers, the menus and the questions take the focus and work with the keys above, and a row's menu opens with the menu key or VoiceOver's menu command as it does with a secondary click.
- VoiceOver hears each control by name, each list and tree with its items and their states, menus as menus and questions as alerts.
