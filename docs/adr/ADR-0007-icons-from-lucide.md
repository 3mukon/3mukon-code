---
id: ADR-0007
type: adr
title: Take the app's icons from Lucide, through the ui module
status: accepted
visibility: public
date: 2026-10-26
summary: The UI takes its icons from Lucide (`lucide-react`, ISC licence), which the ui module re-exports as decorative components so that no other module imports the set directly; hand-drawn icons and SF Symbols were rejected
scope: ["src/ui/**", "src/**/renderer/**", "package.json"]
tags: []
supersedes: []
superseded_by:
---

## Context

The UI needs a growing set of icons: New session now, and with the coming work stop, send, folders, files, diffs, approvals and settings. The first icon, New session's plus, was drawn by hand as an inline SVG; on 2026-10-26 the maintainer asked for the icons to come from an icon set instead.

## Options

- Lucide through `lucide-react` (chosen): one consistent set drawn on a 24-pixel grid with 2-pixel strokes, including folders, files, branches and terminals; ISC licence. Each icon is a React component that renders inline SVG in `currentColor`, so icons take the tokens' colours, and icons the app does not import stay out of the bundle.
- Hand-drawn inline SVGs: no dependency, but each icon is drawn by hand, and the set drifts in weight and proportion as it grows.
- SF Symbols: the native macOS look, but Apple licenses them as system-provided images under its SDK agreements, which do not cover publishing exported copies in this public repository.

## Decision

The app's icons come from Lucide through `lucide-react`, pinned like the other packages and bundled into the renderer. The ui module exports each icon the app uses from `renderer/icons.tsx`, wrapped so that it is hidden from VoiceOver unless its caller says otherwise; other modules import icons only from there, and a module rule keeps `lucide-react` inside ui. Icons draw in the current text colour and are sized with Tailwind classes.

## Consequences

- Easier: a new icon is one line, and it matches the others.
- Harder: one more package to keep current; Lucide releases often.
- Must stay true: icons come only through the ui module, and an icon is decorative, so whatever shows one names it in words.

## Revisit when

Lucide stops being maintained, or the UI needs icons that Lucide lacks.
