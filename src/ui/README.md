---
id: DOC-mod-ui
type: doc
title: ui module
status: current
visibility: public
date: 2026-10-25
summary: The reference design's tokens, as a dark theme and a warm light theme that follow macOS, and the presentational components and icons other modules build their UI from
scope: ["src/ui/**"]
tags: []
---

## Responsibilities

- Design tokens (`renderer/tokens.css`): the colours, an e-ink look after the Ink Paper theme on its Flexoki palette, switched by macOS's appearance: near-black ink on a warm grey paper in the light theme, and pale ink on dark paper in the dark one, with colour kept for states, changes and the accent, cyan in the light theme and orange in the dark one as Ink Paper has them; `menu-line`, the dashed ink line around a sheet that opens over the window, such as a select's list, and the `paper` utility, which draws such a sheet as the window's own paper, grain and all, without a shadow, as e-ink draws it; the message tokens, `bubble` for the fill of the user's messages, a darker paper, and `bubble-line` for the outline of the agent's; `well` for paper set apart under a dashed line, such as a tool call's output, a diff and a code block; `placeholder` for what an empty field shows, fainter than the labels around it; `scrim` behind an image enlarged over the window; the syntax colours (`syntax-*`), Flexoki's for comments, keywords, functions, constants, strings, variables, numbers, language features and what is invalid; and the grain (`grain-image`, `grain-opacity`): `renderer/grain.svg`, a tile of faint noise with dark specks for the light paper, and `renderer/grain-pale.svg`, the same with pale specks for the dark one, which the app module lays over the window and the `paper` utility lays under a sheet at the same strength (`paper-veil`). Also the blinking of the ellipsis after Working (`animate-blink`), what a wait says only once it has lasted 300 ms (`animate-appear`), and the system fonts (SF Pro, SF Mono). Tailwind exposes them as classes such as `bg-frame`, `text-muted` and `border-line`; its default palette is removed, so every colour comes from a token.
- Presentational components, which take their data and text as props:
  - `StatusDot` (`renderer/status-dot.tsx`): a status (running, waiting, done or idle) as a coloured dot, which keeps its size in a line of text too.
  - `WaitingIndicator` (`renderer/waiting-indicator.tsx`): the count of sessions waiting on the user, with a waiting dot, as a button for the title bar; it renders nothing at zero.
  - `Pane` (`renderer/pane.tsx`): a pane with a header as tall as the title bar (status, title, a detail with its tooltip, a close button) above a body that its content lays out and scrolls itself; it takes focus as a whole, is marked current while it has focus, and is dimmed while another pane has it. A header can show something at its start, before the status and title, such as what lies beside the window buttons. A pane that holds unsaved changes shows a dot in its close button until the pointer or the keyboard reaches it, as macOS's documents do, and VoiceOver hears it after the title. A header can lie in the title bar, moving the window from its empty part, and leave room for macOS's window buttons; the title and detail are a handle, whose text does not select, that gives its parent the presses by which it moves the pane with the pointer, and never starts a drag of the system's.
  - `Divider` (`renderer/divider.tsx`): the line between the two parts of a split, side by side or stacked, placed by its parent; the pointer drags it, or it takes focus and moves with the arrow keys along the split (Shift for larger steps), Home and End, keeping each part at least `minPanelWidth` wide or `minPanelHeight` tall while the space allows (`renderer/split.ts`).
  - `Select` (`renderer/select.tsx`): a compact choice of one option, the chosen option's text in small type with a chevron after it, which keeps its left edge whatever the text's width; its list, a sheet of the window's paper (`paper`) under a dashed line and without a shadow, opens just below it, from that edge, and marks the chosen option with the select's own checkmark. A select in Chromium's customizable appearance (`appearance: base-select`) lies over the text, invisible but for its focus ring and its list, so that the keyboard and VoiceOver handle it as any select.
  - `Menu` (`renderer/menu.tsx`): a menu at a point, a sheet of the window's paper under a dashed line as a select's list is drawn, which opens below and to the right of its point, or above and to the left where the window has no room, with the focus on its first item. The arrow keys, Home and End move between the items, as the pointer does, and a letter to the next item it begins; a click, Return or Space chooses one. It closes without a choice at Escape, at a press of the pointer or a turn of the wheel beside it, and as the window loses the focus or changes size, but not at the release of the press that asked for it, which may come once it shows: it is a manual popover that closes itself, not an automatic one (L-0002). VoiceOver hears a menu of items, a checked one as checked.
  - `QuestionDialog` (`renderer/question.tsx`): a question over the window, a modal sheet of the window's paper under a dashed line, hung just below the title bar: its message in bold, its detail, and its answers in a row, the first at the right and any beyond the second apart at the left, as macOS lays out a sheet's buttons. The default answer is drawn in ink and has the focus, so that Return gives it, and Escape gives the cancel answer; until it is answered nothing else in the window can be reached. VoiceOver hears an alert, with its message and detail.
- The prompts (`shared/prompts.ts`, ADR-0013): what the main process asks the user in a window, as plain data both processes share: a menu's entries (`MenuEntry`), items with an id and a label, checked or not, and separators, and a question (`Question`), its message, detail and answers, the first the main one, with its default and cancel answers, either one a `Prompt`; and `Prompts`, which shows them and resolves with the user's choice, which the app module implements and the feature modules' main-process code asks through, and which the two components above draw.
- Icons (`renderer/icons.tsx`): the Lucide icons the app uses (ADR-0007), as components that draw in the current text colour and are hidden from VoiceOver.

## Not responsible for

- Text: components receive their visible and accessible text already translated, from callers that use the i18n module.
- State and data, such as which sessions exist or wait: the feature modules own them and pass them in.
- The window's layout: the app module composes the shell.

## Interface

- `renderer/tokens.css`, imported once by the app module's stylesheet, and `renderer/grain.svg`, which that stylesheet lays over the window.
- The components above, the icons, `clampRatio`, `minPanelWidth` and `minPanelHeight`, each imported from its file in `renderer/`.
- For both processes: `Prompts`, `Prompt`, `MenuEntry`, `MenuItem`, `Question` and `itemIds` from `shared/prompts.ts`.

## Dependencies

- Uses React and Lucide (`lucide-react`), and imports no other module; the rule `ui-imports-no-module` in `.dependency-cruiser.js` enforces it.
- Every other module may import it, and takes its icons only from it: the rule `icons-only-through-ui` keeps `lucide-react` inside this module.

## Invariants

- Colours come only from the tokens; a new colour is a new token in both themes.
- Every interactive component can be reached and operated from the keyboard and is labelled for VoiceOver; decorative parts such as status dots are hidden from VoiceOver, and their meaning is given in words.
- Icons come only from Lucide, through `renderer/icons.tsx`; a new icon is a new export there and, like the others, is hidden from VoiceOver, so whatever shows it names it in words.
