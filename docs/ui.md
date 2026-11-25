---
id: DOC-ui
type: doc
title: The window, its panels, keys and look
status: current
visibility: public
date: 2026-11-04
summary: One window holds a sidebar of workspaces and sessions beside a main area of panels that split, move and close, with the title bar's buttons for archived sessions, accounts, settings and waiting sessions; agents' browser and computer use shows in their sessions and in panels they present; it is drawn in an e-ink look in light and dark, in English or Simplified Chinese, shows the main process's menus and questions in its own page, and works from the keyboard as well as the pointer
scope: ["src/*/renderer/**", "src/app/main/window.ts", "src/app/main/prompts.ts", "src/ui/shared/**"]
tags: []
supersedes: []
superseded_by:
---

The app has one main window, built from the feature modules' renderer parts and composed by the app module. This page is the map: what the window shows, where, and which module owns each part. The module READMEs hold the details; the ADRs and lessons cited give the reasons.

## The window

- **Title bar**: the window's top 40 pixels, which move the window and show no title. macOS's window buttons sit in it, and just after them, in the same place whether the sidebar shows or not, the sidebar's button, which hides and shows the sidebar as ⌘B does, the archived sessions' button, the accounts' gauge, the settings' gear and, while any session waits on the user, the count of waiting sessions. Over the main area, the title bar holds the headers of the panels at the top; while the sidebar is hidden, the header under the window buttons leaves room for them and for what lies after them, and that room grows and shrinks as the sidebar closes and opens, so that the header's title never passes beneath them. (DOC-mod-app)
- **Sidebar**, 220 pixels wide, which its button in the title bar and ⌘B hide and show, and which the window opens as the user last left it; hiding it with the focus inside gives the focus to the focused panel: the app's name; the Workspaces section, with Add workspace and the workspaces as a tree of their folders and files (DOC-mod-workspaces); then the Sessions section, with New session, a filter by workspace and a search by title and conversation, and the sessions not archived, the most recently active first, each child session indented beneath the session that started it (ADR-0036), and each titled once it has run for a while (ADR-0035) (DOC-mod-sessions).
- **Main area**: the panel area, empty until something opens in it (DOC-mod-panels).
- The page itself never scrolls; each pane and list scrolls within itself (L-0001). The paper's grain lies behind the content, including on filled surfaces (L-0009). (DOC-mod-ui)

## Panels

Each panel is a pane with a header, which can lie in the title bar, holding its title, a detail such as its folder's name, its status, actions and a close button. The focused panel is marked current and the others dim.

| Panel | Shows | Module |
|---|---|---|
| Session page | A new session's settings and composer; once its first message is sent, the session itself | DOC-mod-sessions |
| Session | A session's activity, its approvals and questions in place, the notices of new messages from other sessions as the app's, its settings and composer; a child's first message, its task, named as its parent's (ADR-0036) | DOC-mod-sessions, DOC-mod-approvals |
| File | A file rendered in its format, or its raw text in the editor, with a toggle between them at the header's end (ADR-0011, ADR-0018) | DOC-mod-files |
| Terminal | The user's login shell in a folder, or a provider's sign-in command (ADR-0015, ADR-0016) | DOC-mod-terminal |
| Archived sessions | The archived sessions, searchable, each unarchived or removed from its row | DOC-mod-sessions |
| Accounts | Each provider's sign-in and its subscription's usage limits (ADR-0017) | DOC-mod-accounts |
| Settings | The language, the appearance, whether tooltips show, Browser use and Computer use | DOC-mod-settings, DOC-mod-browser, DOC-mod-computer |
| Browser tab | A tab of the app's browser, live, with Back, Forward and Reload; or a preview of an agent's Chrome tab with its age and Open in Chrome (ADR-0027, ADR-0030) | DOC-mod-browser |
| App window | A preview of another app's window, with its age and Switch to (ADR-0027) | DOC-mod-computer |
| Result | Markdown, an image or a table an agent presents (ADR-0027) | DOC-mod-panels |

- **Opening**: a click on a session shows it; New session opens a session page in the selected workspace's folder; a row of a tree or list dragged into the area opens there, filling it, beside a panel near its edge, or in its place in its middle, as do files and folders dragged from the Finder. The archived sessions', accounts' and settings' panels show once each; opening one again focuses it.
- **Arranging**: a panel's title drags it beside another or swaps the two; the dividers between panels drag, or take focus and move with the arrow keys. The app's own drags use the pointer's own events, never a drag of the system's (L-0003).
- **Presented panels**: an agent can present files, results, pages and app windows. They open beside its session's panel, or in place of its earlier presentation where the area has no room, without the focus and dimmed, and VoiceOver announces them. Those that arrive during a drag wait for the drop. The session's activity keeps Show for each presentation, and the agent is told when the user closes one.
- **Closing**: a panel with unsaved changes asks first, and so does a terminal while a program other than the shell runs in it.

## Agents' browser and computer use

What agents do with the app's browser, Chrome and other apps shows where the session is (ADR-0027). (DOC-mod-sessions, DOC-mod-approvals, DOC-mod-browser, DOC-mod-computer)

- **In the activity**: each call of these tools says what it did and to what, such as Opened example.com/pricing or Clicked “Save Draft” with Mail. The call that opens a page says how the page is shared (No sharing, App sign-ins, or Chrome with its profile) and whether the work runs in the background or the foreground. What came of the call follows, and its screenshots lie under it.
- **Approvals**: an operation beyond what the session reaches unasked asks once, at the activity's end: a page with shared sign-ins, an app in the background or the foreground, or a dialog. The approval says what it covers and how long each answer lasts, and answers as the providers' approvals do. Once answered, it stays before the call that asked, saying when its grant ended, or with End while it is in force. A session waiting on one counts as waiting, and an approval waits until the user answers.
- **Above the composer**: what the session uses, with Show and Stop, and the grants in use, whose Show lists each grant with End.
- **Setup**: a call that needs setup leaves a notice with the step that starts it, such as connecting Chrome or allowing Screen Recording. Setup starts only from the user's click, there or in Settings.
- **Foreground control**: while an agent drives an app with the keyboard and pointer, a small control lies just above the app's window and goes with it: whatever covers that window covers the control, and where the window is past a display's edge or under the menu bar, so is the control. In full screen it lies at the top of the display. It never takes the focus. It names the session and the app, with Stop and the stop shortcut, until the agent is done in the foreground. Moving the mouse or typing while the agent acts pauses it, and Hand Back gives the app back to it. (ADR-0034)

## Keys

| Keys | What they do |
|---|---|
| ⌘B | Hide or show the sidebar |
| ⌘, | Open the settings |
| ⇧⌘A | Show the session that has waited longest on the user, then the next at each press |
| ⌃⌥⌘. | Stop an agent's work in the foreground, from any app |
| ⌃` | Open a terminal beside the focused panel, in its folder |
| ⌘D, ⇧⌘D | Split the focused panel to the right or downwards, with a session page in its folder |
| ⌘W | Close the focused panel |
| ⌘1 to ⌘9 | Focus the panels in reading order |
| ⌥⌘ and an arrow | Focus the next panel that way |
| ⇧⌥⌘ and an arrow | Swap the focused panel with the next one that way |
| ⌘↓ | Open the focused row of a workspace's tree in the panel area |
| ⌘S | Save the file in the focused panel |
| Return, ⇧Return | Send a message; start a new line in it |
| Return, ⌥Return, Escape | In an approval, a provider's or an operation's: give its default answer, allow for the session, deny |
| 1 to 9, Return, Escape | In a question: choose by number, answer, skip |

The workspaces' tree moves as macOS lists do, with the arrow keys, Home and End.

## Menus and questions

The main process's menus and questions show in the page, in the app's own look, one at a time in the order asked (ADR-0013): a menu at the pointer, such as a workspace's, a folder's or a session's, and a question over the window, such as the trust question when a workspace is added or a confirmation before something ends or goes. The folder picker, the save panel and the question before a window with unsaved changes closes stay macOS's own. (DOC-mod-app, DOC-mod-ui)

## Look

- An e-ink look after the Ink Paper theme on the Flexoki palette: ink on a warm grey paper in light appearance and pale ink on dark paper in dark, with a faint grain on the paper, sheets drawn as the paper itself under a dashed line and no shadows. Colour is kept for what it means: states, additions and deletions, warnings and the accent. (DOC-mod-ui)
- Scrollbars are macOS's own, in the paper's ink: a thumb in the dashed line's ink with no strip beneath it, also while hovered or dragged. (DOC-mod-app)
- Tooltips are off at first and turn on in the settings: then they are the app's own, drawn in the page as a sheet of the paper under a dashed line, after the pointer rests half a second on a control or as the keyboard focuses it (ADR-0021). (DOC-mod-ui, DOC-mod-settings)
- The appearance follows the Appearance setting: System, which follows macOS, Light or Dark.
- The system's fonts, SF Pro and SF Mono, and Lucide's icons (ADR-0007).
- Messages and Markdown files render with the same renderer, with math and highlighted code (ADR-0010, ADR-0018).

## Language

The window and the main process's menus and questions are in English or Simplified Chinese, following the Language setting: System, which takes macOS's preferred languages, English or 简体中文. Every string exists in both catalogs. Names that come from the providers or their files stay as they are in either language: models, gateways and reasoning effort levels, the levels with a capital first letter as the other settings have. (DOC-mod-i18n)

## Access

- The lists, the trees, the dividers, the menus and the questions take the focus and work with the keys above, and a row's menu opens with the menu key or VoiceOver's menu command as it does with a secondary click.
- VoiceOver hears each control by name, each list and tree with its items and their states, menus as menus and questions as alerts. A button whose label alone would not say what it acts on, as End among several grants, is heard with what it acts on. The floating control's buttons are native for VoiceOver.
