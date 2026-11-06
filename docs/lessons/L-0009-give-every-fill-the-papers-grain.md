---
id: L-0009
type: lesson
title: Give every opaque fill the paper's grain, not a flat colour
status: active
visibility: public
date: 2026-11-06
summary: The window's grain is drawn once, on a layer behind everything in the window, so a surface filled with an opaque colour covers it and shows as a smooth patch beside the grainy paper, even when the colour is the palette's own and measures right; fill a surface with the ui module's paper utilities, or with the grain tokens where Tailwind does not reach, which lay the grain over its colour at the window's strength, or leave it clear so that the window's grain shows through
scope: ["src/**/renderer/**", "tests/smoke/rendered-files.spec.ts", "tests/smoke/sessions.spec.ts"]
tags: []
level: test
occurrences: 4
---

## Symptom

```text
Filled surfaces showed as smooth, flat colour beside the grainy paper around them, in both
appearances:
- a select's list, the compact session settings' dropdown and the editor's tooltips, a lighter paper
  of their own;
- a terminal panel, black in the light appearance, and the box an input method composes in, white on
  black;
- the empty areas of an approval or question block, in the well's colour;
- code blocks, inline code, quotes, table headers, tool output and diffs, the user's message bubble,
  the file editor's status bar, fields and fold markers, and an image's frame.
Where the colour was a token's, the surface's computed background colour was exactly that token.
```

## Root cause

The app module draws the grain once for the whole window: its stylesheet lays `grain.svg`, or `grain-pale.svg` in the dark appearance, at the grain's opacity on a fixed layer behind everything else (`body::before`, at `z-index: -1`). The grain shows only where nothing above that layer paints a background, so any opaque fill covers it, however close its colour is to the paper's: a Tailwind class such as `bg-well`, `bg-bubble` or `bg-frame`, which sets a colour and nothing more; a sheet in the top layer, which must be opaque to hide what lies under it; CodeMirror's theme; and xterm.js's own stylesheet, which paints the terminal's viewport black behind the emulator's theme and the input method's box white on black.

## Why it looked right

Each fill took its colour from the palette's tokens, the well's, the bubble's or a lighter paper's, so it kept to the e-ink look's colours, and checks of a surface's colour, its computed style included, found it right. The grain is faint, at an opacity of 0.1 in the light appearance and 0.08 in the dark, and it comes from a layer the app module draws, which nothing in a component's classes or a library's stylesheet shows; a flat patch stands out only beside the grainy paper. A class such as `bg-well` reads as the well's paper, while it sets only a colour.

## Fix

Fill a surface with the ui module's paper utilities (DOC-mod-ui): `paper` for the window's paper, on a sheet over the window or a small control, `paper-well` for the well and `paper-bubble` for the user's messages. Each paints its colour, then the grain, then the same colour again at the strength the grain leaves, so that the grain shows as it does on the window, and its opaque base keeps a fill inside another, such as inline code in a quote, from adding a tint. Where Tailwind's classes do not reach, as in CodeMirror's theme and the terminal's stylesheet, a surface takes its colour with the grain token of the same paper as its background image: `--paper-grain`, `--well-grain` or `--bubble-grain`. A surface without a colour of its own stays clear, so that the window's grain shows through, as the terminal's background does, and a state's tint over a fill, such as a hover's, stays translucent. `tests/smoke/rendered-files.spec.ts` checks the colour and the grain of rendered Markdown's code blocks, inline code, quotes and table headers in both appearances, and the grain of a CSV table's header; `tests/smoke/sessions.spec.ts` checks the user's message bubble in both appearances. A new filled surface belongs in these checks.

## Occurrences

- 2026-10-30: the selects' lists, the compact session settings' dropdown and the editor's tooltips, sheets of a lighter paper under a shadow, which took the `paper` utility.
- 2026-11-04: a terminal panel, which xterm.js's stylesheet painted black behind the emulator's clear theme, and its input method's box; the terminal's stylesheet cleared the viewport and gave the box the darker paper, still without the grain.
- 2026-11-04: the empty areas of an approval or question block, filled with the well's colour; the block moved onto the window's paper.
- 2026-11-06: the remaining fills, the terminal's input method box among them, which took `paper-well`, `paper-bubble` and the grain tokens; the guardrail moved up from the ui module's README to the smoke tests' checks of the grain.
