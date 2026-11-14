---
id: ADR-0022
type: adr
title: Show agents' browser and computer use in their sessions and in panels, and ask once for each operation beyond a session's reach
status: accepted
visibility: public
date: 2026-11-12
summary: What agents do in browsers and other applications shows in their session's activity and in a line above its composer, a page or another application's window opens as a panel beside the session only when presented and without the focus, foreground control shows a small floating control with Stop, and each operation beyond what a session reaches unasked asks once in place with the approvals' own answers, because the user often works in the same window or on the same Mac and must see, grant and stop what acts as them; a window of its own for automation, a menu bar indicator, approvals for each action or for a whole task, and marks on presented panels were rejected
scope: ["src/sessions/renderer/**", "src/approvals/renderer/**", "src/panels/renderer/**", "src/browser/renderer/**", "src/computer/renderer/**", "src/settings/renderer/**", "src/app/renderer/**", "src/ui/renderer/**", "src/i18n/catalogs/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

The app is to give every provider's agents one set of tools, served by its toolset (ADR-0009), to browse the web, to observe and operate other macOS applications, and to present what they find in the panel area. A page can be opened with no sharing, in a context of the session's own; with the app's sign-ins, in the app's own browser profile, which every session shares so that the user signs in to a site once; or in the user's own Chrome or Safari, with their sign-ins. An application can be observed and operated in the background, without bringing it forward, or in the foreground, with the keyboard and pointer.

The user is often working in the same window, or elsewhere on the same Mac, while agents work: background work must not take the focus, bring a window forward or move the pointer, and an observation must not open or change a panel. Working with shared sign-ins or with the keyboard and pointer acts as the user, so it must be granted knowingly, yet without a question at every click, which the providers' automatic mode exists to avoid (ADR-0006). The user must always see what a session uses and be able to stop it: from the session, without a panel, and from another application.

The window has patterns to build on. A session's activity shows each tool call as an entry, and its approvals and questions are answered in place, with Allow Once, Allow for This Session and Deny, by Return, ⌥Return and Escape. Unfocused panels fade to 70% of their opacity. Menus and questions are drawn in the page (ADR-0013). A browser view, however, is a native view laid over the page: the page's menus, questions and drags cannot show above it, and the page's opacity does not reach it.

Probes have measured part of what this design leans on. A page's frame is captured in a few milliseconds and reaches the window's renderer in about 40 to 55 ms, though a confirmed readback from the compositor can take several times as long; a layer of the paper's colour dims a live page and takes the focusing click; Chrome captures a tab that is not in front, and other applications' windows are captured in every window state, without bringing anything forward. Not yet seen: a preview of a Safari tab that is not in front, noticing the user's input on a clean installation, a click on the floating control, and what a permission's grant needs to take effect. The probes also showed that a target can bring itself forward in response to an action, that a page's own dialog can bring a hidden page's window forward, and that Secure Input hides keystrokes from the app. Where the window depends on something not yet seen, this decision says what it does if the backend cannot.

## Options

- Where the work shows:
  - In its session (chosen): each action as a tool call in the activity, and a line above the composer naming what the session uses, with Show and Stop.
  - A window or dashboard of its own for automation: one place for every agent's work, but apart from the conversation that explains it, and one more window to manage.
  - A menu bar indicator: visible from anywhere, but a second place to look, and it cannot show the page.
- How pages show:
  - In the background by default, and in a panel only when presented (chosen).
  - Always in a panel while used: easy to follow, but every observation would open or change a panel and could move the focus.
  - Always in the user's own browser: nothing to embed, but bringing Chrome or Safari forward takes the focus and can switch Spaces.
- A browser panel's own menu:
  - None, as no other panel has one: the header holds Back, Forward and Reload, and a secondary click in the page is the page's own (chosen).
  - A context menu of the app's on the page, with actions such as Reload or Copy Address: a second place for the header's actions, which no other panel has.
- Chrome and Safari tabs:
  - A preview that takes no input, with Open in Chrome or Open in Safari, which brings that same tab to the front, still signed in (chosen).
  - The tab mirrored in a panel that takes input: input relayed into another browser is unreliable, and the user would have two places to type into one page.
  - The tab moved into the app's browser: it would lose the browser's own sign-ins and extensions.
- The page's menus, questions and drags over a browser panel:
  - A still frame of the page in place of the live view while anything covers it: a fresh capture where it is ready within the budget, else the latest frame kept from the page's last load, scroll or resize, else the panel's paper with the page's title and address (chosen).
  - A fresh capture each time and nothing else: the page's real look, but a menu would wait for the capture.
  - Menus closed or kept away from browser panels: they would behave unlike every other panel's.
  - The page's overlays drawn in a window of their own above the view: the page stays live, but every menu, question and drag would need a window, and the keyboard's focus would cross windows.
- An unfocused browser panel:
  - Dimmed under a native layer of the paper's colour at the strength with which other panels fade, the click that focuses it only focusing it (chosen); its header and frame alone dimmed where no such layer can lie above the page.
  - A black or grey layer: simple, but it darkens a light page where every other panel fades towards the paper.
  - A dimmed still frame: matches the others exactly, but the page would stop moving while an agent works in it.
  - The focusing click passed through to the page: one click fewer, but that click would take the tab from an agent working in it.
- Presented panels:
  - Beside the session's panel, or in place of its earlier presentation where the area has no room, without the focus, dimmed as an unfocused panel, announced by VoiceOver and with no mark of its own; a presentation the user closes stays closed (chosen).
  - Taking the focus: seen at once, but it would break the user's typing.
  - A mark on presented panels: another visual language, where the session's activity already records each presentation.
  - Letting the model reopen a closed presentation when it has a new reason: the user would lose control of their own panel area.
- Previews of tabs and windows that may not be capturable:
  - The latest frame with its age, else the last one kept, else the page's or window's title, and nothing brought forward to take one (chosen).
  - Bringing the tab or window forward for a moment to capture it: a current image, but background work would then take the focus.
- A target that brings itself forward in response to an action:
  - Named in that operation's approval, recorded when it happens with the floating control shown, and contained by the backend where code can (chosen).
  - Asked first as a foreground operation, before any action that could cause it: in Chrome almost every click could, so nearly every action would ask, and the target would come forward every time.
  - Refused in the background: nothing comes forward unexpectedly, but agents would lose most clicks in Chrome, Safari and other applications.
- Dialogs from pages in the app's browser:
  - Disabled, each dismissed as Cancel would dismiss it, with the agent told (chosen).
  - Left to the browser engine: a hidden page's alert brings the app's window forward.
  - Drawn by the app in its own look: the user would see them, but that needs a route from the page to the app that does not exist yet.
- Foreground control:
  - A small control that stays above other applications without taking the focus, naming the session and the application, with Stop, and a shortcut, ⌃⌥⌘., that stops foreground control from anywhere (chosen).
  - A menu bar item alone: always there, but small and easily missed while the agent moves the pointer.
  - A border or overlay over the whole screen: unmistakable, but it covers the content and could take input meant for the application.
- Noticing that the user takes over:
  - With Accessibility alone where macOS allows it, and otherwise with one more permission, such as Input Monitoring, set up from the user's own click before foreground control starts; input that cannot be told apart counts as the user's (chosen).
  - Always asking for Input Monitoring: certain, but a further permission even where it is not needed.
  - Stop and the shortcut alone, without noticing the user's input: no permission, but an agent could keep moving the pointer while the user reaches for it.
- Approvals:
  - Once for each operation beyond what the session reaches unasked, in place in the activity with the approvals' own answers and keys, and Allow for This Session for the same kind of operation on the same target; the grants in use listed above the composer, each with End; none in yolo (chosen).
  - Once for each action: a question at every click.
  - Once for a whole task: the user could not tell what they had allowed, or when it would end.
  - The grants in the session's settings: away from the conversation in which they are used.
- Setup:
  - Two settings, Browser use and Computer use, and a notice in the session when a tool needs setup; setup starts only from the user's own click (chosen).
  - A guide at the first launch: it would interrupt users who never use these tools.
  - Setup started by the tools when they need it: background work could open System Settings, an extension's page or an installer unasked.

## Decision

A session's browser and computer work shows in its activity: each action as a tool call naming the site or the application, how its page is shared (No sharing, App sign-ins, Chrome with its profile, or Safari) and whether it runs in the background or the foreground, with the screenshots it took, which show small and enlarge as other images do. A tool call says whether its effect was checked: an action whose result the agent saw is done, one sent without a check says so, and one stopped part-way says that it may have happened. A page of the app's browser cannot open a dialog: alert, confirm and prompt are dismissed as Cancel would dismiss them, and the activity says so, as the agent is told. While a session uses a tab or an application, a line above the composer's divider names it, with Show, which presents it, and Stop. The composer and its settings stay as they are, and stopping the turn stops this work too, leaving the tabs open and the sign-ins in place.

A page works in the background until the agent or the user presents it. Its panel's header gives the page's title and address, how it is shared, with the profile or browser, and the session using it, with Back, Forward and Reload. The panel has no context menu of its own, as no other panel has: a secondary click in the page is the page's own, and the app adds nothing to it. While the agent acts, a thin line runs along the page's top and a chip names the session, with Stop; a click or a key in the page takes the tab from the agent, which is told and waits until the user hands it back with Hand Back. A page of the app's browser is live in its panel. A page that loads or fails shows the window's paper rather than a blank white page: while it loads, Reload turns into Stop Loading, and one that cannot load says why, with Try Again. While the agent waits for the user's answer to work in a tab, the tab's panel says so, with Show, which takes the user to the question.

While a menu, a question, a drop's highlight or a dragged item covers a browser panel, the panel shows a still frame of its page and turns live again once it is uncovered. The frame is in place within 100 ms of whatever covers the panel, since menus open at once elsewhere in the window: a fresh capture where one is ready that soon, otherwise the latest frame kept from the page's last load, scroll or resize, and where there is none, the panel's paper with the page's title and address. An unfocused browser panel dims as the others do, under a native layer of the paper's colour at the strength with which they fade, which follows the appearance; the click that focuses it only focuses it, so that it never reaches the page and never takes the tab from the agent.

A Chrome or Safari tab shows as a preview that takes no input, with Open in Chrome or Open in Safari, which reveals that same tab and never opens a copy of it. A preview shows its latest frame and how old it is. Where no frame can be taken without bringing the tab or its window forward, as for a Safari tab that is not the one in front in its window, it keeps the last frame it had, with its age, or shows the page's title and address; nothing is ever brought forward to take a frame.

A presented panel, whether a page, a preview of another application's window, a file or a result such as Markdown, an image or a table, opens beside its session's panel, or in place of that session's earlier presentation where the area has no room, without the focus and without bringing the window forward. It stays dimmed as an unfocused panel, VoiceOver announces it, and one that arrives during a drag waits for the drop. A preview of another application's window takes no input, as a Chrome or Safari tab's does, with a button that brings the application forward, such as Switch to Mail, and Stop; showing it grants nothing, and hiding it stops nothing. It needs Screen Recording, and until that is allowed it shows the step that allows it. Its first frame can take about a second, during which it says it is loading, and a window that cannot be captured shows its last frame with its age, or its title. A comparison is one presentation, its panels side by side. The activity records each presentation, with Show. A presentation the user closes stays closed: the model never reopens it of its own accord, and it shows again only when the user asks, with Show or in a message.

While an agent works in the foreground, a small control stays above every application and Space without taking the focus, in one place on the display where the agent works, naming the session and the application, with Stop; it shows only then. ⌃⌥⌘. stops foreground control from anywhere; where it cannot be registered, the control shows no shortcut and Stop remains. The user's own pointer or keyboard pauses foreground control, the agent is told, and the control says so where it was, with Hand Back and Stop. Telling the user's input from the agent's needs no permission the user has not been asked for: where macOS allows it with Accessibility alone, nothing more is set up; where it needs another, such as Input Monitoring, that permission is one more Computer use item, set up only from the user's click, and foreground control waits until it is allowed. Input that cannot be told apart counts as the user's: the app keeps its own record of what it sends, since a page receives the agent's input and the user's alike. While Secure Input is on, as when a password field has the keyboard, the app cannot see the user's keystrokes, so foreground control pauses, and the control says why, with Stop. Stop and the shortcut never depend on noticing the user's input. Where macOS keeps the control from a surface, such as the lock screen, the shortcut and the session's Stop still work.

A target can bring itself forward in response to an action, as a page's popup in Chrome or Safari does, or an application opening and activating its own window. Where the backend cannot rule that out for an operation, that operation's approval says so, such as "may bring Chrome to the front"; when it happens, the activity records it and the floating control shows, as in foreground control, until the agent is done with the target, the user takes over or the user stops it. It is not a foreground operation: nothing more is asked, and the tools never bring a target forward themselves. Where code can contain the response before it happens, as for popups that the agent's own clicks open, the backend contains it.

One operation is one agent's use, within one turn, of one target beyond what its session reaches unasked: a tab with shared sign-ins, in the app's browser or in Chrome or Safari; one application's windows, to observe or act on in the background; or the keyboard and pointer in the foreground for one application. A system dialog that a page or an application opens, such as a file picker, is an operation of its own. Each asks once, in place in the activity, with the approvals' own answers and keys. Allow Once covers the operation until the agent is done with the target, the turn ends, the user stops the agent or takes over, or the user ends it; Allow for This Session covers the same kind of operation on the same target until the session ends or the user ends it; Deny refuses it. Everything inside an allowed operation, clicks, typing, navigation within the tab and screenshots among them, goes ahead without asking. Each answered approval stays in the activity, saying how it was answered and, once it has ended, when; a grant still in force has End there too. Browsing with no sharing, listing the browsers and applications there are, and presenting, updating or closing panels never ask; in yolo nothing asks (ADR-0006). The session's sandbox bounds these tools as it bounds the providers' own: in Read-only they observe and never act, a tool that would act being refused for the level without asking, and in Workspace write what they download, upload or pick stays in the session's folder and the temporary folders. While a session holds grants, a line above the composer says how many, and Show lists each, for the operation or for the session, with End, which ends it at once, queued work included.

The settings' panel gains two settings, built as Language and Appearance are: Browser use, with the app's browser and its sign-ins, Chrome and Safari, and Computer use, with the macOS permissions computer use needs, Accessibility and Screen Recording, and Input Monitoring only where noticing the user's input needs it. Once an item is set up, its state shows in small type right after its name; the line under its name says what it is, and the group's right holds only buttons. An item that cannot be set up from the app says what it needs instead, such as the version of Chrome that a connection requires. A permission names the entry the user will find in System Settings, and one that takes effect only once the app's helper restarts says so, the app restarting its helper itself and never the user's applications. A tool that needs setup leaves a notice in its session, with the step that starts it; setup starts only from the user's own click, there or in the settings.

Every new string is in both catalogs, and the approvals reuse their existing strings.

## Consequences

- Easier: the user sees, grants and stops agents' browser and computer work where the conversation about it is, in one approval vocabulary across the app; a presentation never takes the focus, and background work never shows.
- Harder: a browser panel must keep a recent frame and swap it in within 100 ms whenever the page draws over it, and dim through a native layer; previews must say when no frame can be taken; the foreground control needs a window that floats above other applications without activating, and a global shortcut while it shows; noticing the user's input may add a permission, and Secure Input pauses foreground control; grants must end with their operations, as targets are released, turns end and the user takes over; tool calls must carry whether their effect was checked; the backend must report, for each operation, whether its target may bring itself forward.
- Must stay true: the tools never bring a target forward themselves, not even to capture a frame, and background work never takes the focus or moves the pointer; a target that brings itself forward is named in its approval and recorded; pages in the app's browser never open dialogs; the click that focuses a browser panel never reaches the page; nothing inside an allowed operation asks; nothing reopens a presentation the user closed unless they ask; Stop and the shortcut never depend on noticing the user's input; the app's own windows are never a target; setup never starts unasked.

## Revisit when

- The frame handoff misses its 100 ms budget even from kept frames, or Electron gains a supported way to draw the page above a native view.
- No native layer can lie above a page in the product's own window, so that a browser panel can dim only its header and frame.
- Code proves able to contain every popup and window that targets open, so that approvals no longer need to name the risk.
- Agents' work comes to need page dialogs, so that the app draws them in its own look.
- Noticing the user's input proves to need a permission that users decline, or none at all on every supported macOS.
- One approval per operation proves too frequent for work that spans many tabs or applications in one turn.
- macOS stops letting a window stay above full-screen applications without activating.
