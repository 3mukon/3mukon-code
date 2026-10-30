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

- Design tokens (`renderer/tokens.css`): the colours, an e-ink look after the Ink Paper theme on its Flexoki palette, switched by macOS's appearance: near-black ink on a warm grey paper in the light theme, and pale ink on dark paper in the dark one, with colour kept for states, changes and the accent, cyan in the light theme and orange in the dark one as Ink Paper has them; `menu-line`, the dashed ink line around a sheet that opens over the window, such as a select's list, and the `paper` utility, which draws such a sheet as the window's own paper, grain and all, without a shadow, as e-ink draws it; the message tokens, `bubble` for the fill of the user's messages, a darker paper, and `bubble-line` for the outline of the agent's; `well` for paper set apart under a dashed line, such as a tool call's output, a diff and a code block; `placeholder` for what an empty field shows, fainter than the labels around it; `scrim` behind an image enlarged over the window; the syntax colours (`syntax-*`), Flexoki's for comments, keywords, functions, constants, strings, variables, numbers, language features and what is invalid; and the grain (`grain-image`, `grain-opacity`): `renderer/grain.svg`, a tile of faint noise with dark specks for the light paper, and `renderer/grain-pale.svg`, the same with pale specks for the dark one, which the app module lays over the window and the `paper` utility lays under a sheet at the same strength (`paper-veil`). Also the blinking of the ellipsis after Working (`animate-blink`), and the system fonts (SF Pro, SF Mono). Tailwind exposes them as classes such as `bg-frame`, `text-muted` and `border-line`; its default palette is removed, so every colour comes from a token.
- Presentational components, which take their data and text as props:
  - `StatusDot` (`renderer/status-dot.tsx`): a status (running, waiting, done or idle) as a coloured dot, which keeps its size in a line of text too.
  - `WaitingIndicator` (`renderer/waiting-indicator.tsx`): the title bar's count of sessions waiting on the user, as a button; it renders nothing at zero.
  - `Pane` (`renderer/pane.tsx`): a pane with a header as tall as the title bar (status, title, a detail with its tooltip, a close button) above a body that its content lays out and scrolls itself; it takes focus as a whole, is marked current while it has focus, and is dimmed while another pane has it. A pane that holds unsaved changes shows a dot in its close button until the pointer or the keyboard reaches it, as macOS's documents do, and VoiceOver hears it after the title. A header can lie in the title bar, moving the window from its empty part, and leave room for macOS's window buttons; the title and detail are a handle that drags the pane when its parent lets it.
  - `Divider` (`renderer/divider.tsx`): the line between the two parts of a split, side by side or stacked, placed by its parent; the pointer drags it, or it takes focus and moves with the arrow keys along the split (Shift for larger steps), Home and End, keeping each part at least `minPanelWidth` wide or `minPanelHeight` tall while the space allows (`renderer/split.ts`).
  - `Select` (`renderer/select.tsx`): a compact choice of one option, the chosen option's text in small type with a chevron after it, which keeps its left edge whatever the text's width; its list, a sheet of the window's paper (`paper`) under a dashed line and without a shadow, opens just below it, from that edge, and marks the chosen option with the select's own checkmark. A select in Chromium's customizable appearance (`appearance: base-select`) lies over the text, invisible but for its focus ring and its list, so that the keyboard and VoiceOver handle it as any select.
- Icons (`renderer/icons.tsx`): the Lucide icons the app uses (ADR-0007), as components that draw in the current text colour and are hidden from VoiceOver.

## Not responsible for

- Text: components receive their visible and accessible text already translated, from callers that use the i18n module.
- State and data, such as which sessions exist or wait: the feature modules own them and pass them in.
- The window's layout: the app module composes the shell.

## Interface

- `renderer/tokens.css`, imported once by the app module's stylesheet, and `renderer/grain.svg`, which that stylesheet lays over the window.
- The components above, the icons, `clampRatio`, `minPanelWidth` and `minPanelHeight`, each imported from its file in `renderer/`.

## Dependencies

- Uses React and Lucide (`lucide-react`), and imports no other module; the rule `ui-imports-no-module` in `.dependency-cruiser.js` enforces it.
- Every other module may import it, and takes its icons only from it: the rule `icons-only-through-ui` keeps `lucide-react` inside this module.

## Invariants

- Colours come only from the tokens; a new colour is a new token in both themes.
- Every interactive component can be reached and operated from the keyboard and is labelled for VoiceOver; decorative parts such as status dots are hidden from VoiceOver, and their meaning is given in words.
- Icons come only from Lucide, through `renderer/icons.tsx`; a new icon is a new export there and, like the others, is hidden from VoiceOver, so whatever shows it names it in words.
