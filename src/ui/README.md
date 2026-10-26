---
id: DOC-mod-ui
type: doc
title: ui module
status: current
visibility: public
date: 2026-10-25
summary: The reference design's tokens, as a dark and a matching light theme that follow macOS, and the presentational components other modules build their UI from
scope: ["src/ui/**"]
tags: []
---

## Responsibilities

- Design tokens (`renderer/tokens.css`): the colours, with the reference design's palette as the dark theme and a matching light theme, switched by macOS's appearance, and the system fonts (SF Pro, SF Mono). Tailwind exposes them as classes such as `bg-frame`, `text-muted` and `border-line`; its default palette is removed, so every colour comes from a token.
- Presentational components, which take their data and text as props:
  - `StatusDot` (`renderer/status-dot.tsx`): a status (running, waiting, done or idle) as a coloured dot.
  - `WaitingIndicator` (`renderer/waiting-indicator.tsx`): the title bar's count of sessions waiting on the user, as a button; it renders nothing at zero.
  - `Pane` (`renderer/pane.tsx`): a pane with a header (status, title, detail) above a scrolling body, dimmed while the other pane has focus.
  - `SplitPanes` (`renderer/split-panes.tsx`): one pane, or two side by side with a divider that the pointer drags or the keyboard moves (arrow keys, Shift for larger steps, Home, End), keeping each pane at least `minPaneWidth` wide (`renderer/split.ts`).

## Not responsible for

- Text: components receive their visible and accessible text already translated, from callers that use the i18n module.
- State and data, such as which sessions exist or wait: the feature modules own them and pass them in.
- The window's layout: the app module composes the shell.

## Interface

- `renderer/tokens.css`, imported once by the app module's stylesheet.
- The components above, `clampSplit` and `minPaneWidth`, each imported from its file in `renderer/`.

## Dependencies

- Uses React only and imports no other module; the rule `ui-imports-no-module` in `.dependency-cruiser.js` enforces it.
- Every other module may import it.

## Invariants

- Colours come only from the tokens; a new colour is a new token in both themes.
- Every interactive component can be reached and operated from the keyboard and is labelled for VoiceOver; decorative parts such as status dots are hidden from VoiceOver, and their meaning is given in words.
