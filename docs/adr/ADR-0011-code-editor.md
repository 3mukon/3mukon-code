---
id: ADR-0011
type: adr
title: Edit files with CodeMirror 6, assembled from its packages
status: accepted
visibility: public
date: 2026-10-29
summary: The file editor is CodeMirror 6, assembled from its packages, with each file's language loaded on demand through CodeMirror's language data and its look and syntax colours taken from the tokens, because it is modular, stays fast on large files, edits real text for macOS's input methods and VoiceOver, needs no workers or network and follows both appearances through CSS; Monaco Editor, Ace and a highlighted textarea were rejected
scope: ["src/files/**", "package.json"]
tags: []
supersedes: []
superseded_by:
---

## Context

The files module's editor panel shows a file from a workspace or the Finder with syntax highlighting, edits it, saves it with ⌘S, marks unsaved changes and follows changes on disk; the features of an IDE, such as language servers and searching across files, are outside its scope. It runs in the sandboxed window, whose content security policy loads scripts, styles and fonts only from the app's own files and allows inline styles, so nothing may load from the network. The window's colours come from the ui module's tokens, CSS variables that change with the appearance. The editor must take macOS's text input, Chinese input methods included, work with VoiceOver and the keyboard, and stay responsive on files up to the 5 MB it opens.

## Options

- CodeMirror 6 (chosen): small packages for the state, the view, languages, commands, search and bracket closing, under the MIT licence. It edits a contenteditable element, so macOS's text input, input methods and VoiceOver work as they do with other text; it draws only the lines in view and parses with incremental Lezer grammars, so large files stay responsive. Its themes and highlight styles are CSS that can name the tokens' variables, so one theme follows both appearances. Its language data describes about a hundred languages and loads each one on demand from the app's own files, and it needs no workers. The words of its search panel and announcements translate through its phrases.
- Monaco Editor 0.57, VS Code's editor: the richest features, a minimap and language services for TypeScript, JSON, CSS and HTML among them, but a few megabytes of script plus web workers for those services, which overlap the language servers this editor leaves out. Its themes take concrete colours in script, so the tokens would be copied into code and the theme switched by hand with the appearance.
- Ace: mature, but an older architecture with modules and configuration of its own, and a hidden textarea under its own drawing of the text, which serves input methods and VoiceOver less well than editing the text itself.
- A textarea under a highlighted copy of its text: the smallest, but without folding, search, several selections or bracket matching, and slow to highlight a large file again with each keystroke.

## Decision

The editor is CodeMirror 6, assembled from its packages rather than the `codemirror` package's basic setup: `@codemirror/state` 6.7, `@codemirror/view` 6.43, `@codemirror/language` 6.13, `@codemirror/commands` 6.11, `@codemirror/search` 6.7, `@codemirror/autocomplete` 6.20 for bracket closing alone, `@codemirror/language-data` 6.5 and `@lezer/highlight` 1.2. Autocompletion is left out: without language servers it would offer little more than the words already in the file. Each file's language is found by its name in the language data and loaded as the file opens; a file that no description matches stays plain text. The theme and the highlight style name the tokens' variables, the syntax colours being the Flexoki ones that ADR-0010 gives highlight.js, so the editor follows the light and the dark appearance as the rest of the window does. The words of the search panel and the announcements come from the catalogs.

## Consequences

- Easier: about a hundred languages highlighted, search and replace within a file, and a look that follows the tokens without code.
- Harder: the window's script, which the build leaves unminified, grows by about 0.8 MB, and the languages add about 1.6 MB in scripts that load only when a file needs one. The window highlights code with two libraries, highlight.js in messages and Lezer in the editor, each mapped to the same syntax colours.
- Must stay true: the editor loads languages only from the app's own files and nothing from the network; it uses no workers; its colours come from the tokens.

## Revisit when

Language servers or other features of an IDE come into scope, which Monaco Editor or a language server client for CodeMirror would serve; or files larger than the editor opens need editing.
