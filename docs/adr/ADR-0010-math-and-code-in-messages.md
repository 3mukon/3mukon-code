---
id: ADR-0010
type: adr
title: Set the math in messages with KaTeX and highlight their code with highlight.js, as Markdown plugins
status: accepted
visibility: public
date: 2026-10-29
summary: Messages set math with KaTeX through remark-math and rehype-katex, its fonts bundled, and highlight fenced code with highlight.js through rehype-highlight in the tokens' Flexoki syntax colours, because both run synchronously inside react-markdown and work offline; MathJax, Shiki and Prism were rejected
scope: ["src/sessions/renderer/**", "src/ui/renderer/tokens.css", "package.json"]
tags: []
supersedes: []
superseded_by:
---

## Context

ADR-0002 expects agent output to render as Markdown with math and syntax-highlighted code. The renderer, react-markdown with remark-gfm (ADR-0004), did neither, so formulas showed as raw TeX and code as plain text. The window's content security policy allows only the app's own scripts, styles and fonts, and data images, so nothing may load from the network while the app runs. react-markdown renders synchronously, again with each streamed delta of a message.

## Options

- Math:
  - KaTeX through remark-math and rehype-katex (chosen): synchronous and fast enough to set a message again with each delta; MathML beside the formula for VoiceOver; its fonts bundled as the app's own assets; it covers the TeX that models write.
  - MathJax: wider TeX coverage, but its typesetting is asynchronous and its runtime larger, which fits poorly with setting a message again with each delta.
- Highlighting:
  - highlight.js through rehype-highlight and lowlight (chosen): synchronous and class-based, so its colours come from the tokens in both appearances; its common languages cover what agents write.
  - Shiki: grammars and themes as VS Code has them, but asynchronous (react-markdown's async variants), with a large bundle of grammars, a WebAssembly or regular-expression engine, and themes that bring their own colours instead of the tokens'.
  - Prism through refractor: much like highlight.js, without anything that would outweigh highlight.js's integration with rehype.

## Decision

The renderer adds remark-math and rehype-katex, with KaTeX 0.16, the version rehype-katex resolves, its stylesheet imported and its fonts bundled, and rehype-highlight. KaTeX runs without trust, so commands that would link or load anything are refused, and it shows an error in place rather than throwing. It is given TeX in the delimiters that models write: `\(…\)`, `\[…\]`, `$…$` and `$$…$$`, a single dollar counting as math only by Pandoc's rules, so that prices and shell variables in prose stay text. Code is highlighted where its block names its language; highlight.js does not guess. Its classes take the Flexoki syntax colours that the ui module's tokens hold, as the Ink Paper theme that the app's look follows does.

## Consequences

- Easier: formulas and code read as they do in other tools, in both appearances.
- Harder: the window's script grows by about 0.9 MB, and KaTeX's fonts add about 1.2 MB to the app.
- Must stay true: math and code render offline; KaTeX's trust stays off; the colours come from tokens.

## Revisit when

Agents write TeX that KaTeX lacks, or highlighting quality matters enough to pay for Shiki's size and asynchrony.
