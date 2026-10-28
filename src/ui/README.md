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

- Design tokens (`renderer/tokens.css`): the colours, with the reference design's palette as the dark theme and a light theme of warm greys on a warm white, switched by macOS's appearance; the menu tokens (`menu`, `menu-line` and the `menu` shadow) for lists that open over the window, a warm white raised by a soft warm shadow in the light theme and a surface lighter than the panes in the dark one; and the system fonts (SF Pro, SF Mono). Tailwind exposes them as classes such as `bg-frame`, `text-muted` and `border-line`; its default palette is removed, so every colour comes from a token.
- Presentational components, which take their data and text as props:
  - `StatusDot` (`renderer/status-dot.tsx`): a status (running, waiting, done or idle) as a coloured dot.
  - `WaitingIndicator` (`renderer/waiting-indicator.tsx`): the title bar's count of sessions waiting on the user, as a button; it renders nothing at zero.
  - `Pane` (`renderer/pane.tsx`): a pane with a header as tall as the title bar (status, title, a detail with its tooltip, a close button) above a scrolling body; it takes focus as a whole, is marked current while it has focus, and is dimmed while another pane has it. A header can lie in the title bar, moving the window from its empty part, and leave room for macOS's window buttons; the title and detail are a handle that drags the pane when its parent lets it.
  - `Divider` (`renderer/divider.tsx`): the line between the two parts of a split, side by side or stacked, placed by its parent; the pointer drags it, or it takes focus and moves with the arrow keys along the split (Shift for larger steps), Home and End, keeping each part at least `minPanelWidth` wide or `minPanelHeight` tall while the space allows (`renderer/split.ts`).
  - `Select` (`renderer/select.tsx`): a compact choice of one option, the chosen option's text in small type with a chevron after it, which keeps its left edge whatever the text's width; its list, on the menu tokens, opens just below it, from that edge, and marks the chosen option with the select's own checkmark. A select in Chromium's customizable appearance (`appearance: base-select`) lies over the text, invisible but for its focus ring and its list, so that the keyboard and VoiceOver handle it as any select.
- Icons (`renderer/icons.tsx`): the Lucide icons the app uses (ADR-0007), as components that draw in the current text colour and are hidden from VoiceOver.

## Not responsible for

- Text: components receive their visible and accessible text already translated, from callers that use the i18n module.
- State and data, such as which sessions exist or wait: the feature modules own them and pass them in.
- The window's layout: the app module composes the shell.

## Interface

- `renderer/tokens.css`, imported once by the app module's stylesheet.
- The components above, the icons, `clampRatio`, `minPanelWidth` and `minPanelHeight`, each imported from its file in `renderer/`.

## Dependencies

- Uses React and Lucide (`lucide-react`), and imports no other module; the rule `ui-imports-no-module` in `.dependency-cruiser.js` enforces it.
- Every other module may import it, and takes its icons only from it: the rule `icons-only-through-ui` keeps `lucide-react` inside this module.

## Invariants

- Colours come only from the tokens; a new colour is a new token in both themes.
- Every interactive component can be reached and operated from the keyboard and is labelled for VoiceOver; decorative parts such as status dots are hidden from VoiceOver, and their meaning is given in words.
- Icons come only from Lucide, through `renderer/icons.tsx`; a new icon is a new export there and, like the others, is hidden from VoiceOver, so whatever shows it names it in words.
