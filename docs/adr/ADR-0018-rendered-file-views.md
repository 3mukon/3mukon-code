---
id: ADR-0018
type: adr
title: Render files in the window, Markdown with the activity's renderer moved to the ui module and the data formats as one folding tree
status: accepted
visibility: public
date: 2026-11-04
summary: A file's rendered view is drawn in the window by the files module: Markdown with the activity's renderer, which moves to the ui module so that the sessions and files modules share it; JSON, YAML, TOML and XML as one folding tree of the app's own over JSON.parse, yaml 2, smol-toml and the window's DOMParser; CSV and TSV as a table from a reader of the app's own; and SVG as an image, which runs none of its scripts; copying the renderer, viewer libraries per format and drawing files in frames were rejected
scope: ["src/files/**", "src/ui/**", "src/sessions/renderer/**", "src/panels/**", "package.json"]
tags: []
supersedes: []
superseded_by:
---

## Context

A file opened in a panel shows rendered when it is Markdown, JSON, XML, YAML, TOML, CSV, TSV or SVG, with a toggle to its raw text in the editor (ADR-0011). Markdown should render as the activity's messages do, whose renderer lives in the sessions module (ADR-0010), which the files module may not use. The window is sandboxed, loads scripts, styles and fonts only from the app's own files and images only from them or as data, and nothing from the network. A rendered view follows the editor's text, unsaved edits included, and stays responsive on files up to the editor's 5 MB. A file that does not parse says where.

## Options

- Where Markdown's renderer lives: in the ui module (chosen), which every module may use and which holds the app's presentational components; the renderer takes how to draw an image and how to follow a link that is not a web link, so that the activity keeps its thumbnails and a file panel shows the images beside the file and opens linked files. A module of its own would hold one component; the app module handing the files module a renderer would wire a component through the composition; a copy in the files module would drift from the activity's.
- How the data formats render: one folding tree of the app's own over a model of nodes (chosen), whose look the tokens give, for JSON, YAML, TOML and XML alike. Viewer libraries, such as react-json-view-lite or @uiw/react-json-view, cover JSON alone and bring a look of their own.
- What parses them: `JSON.parse`, whose error gives the position; the window's `DOMParser`, whose error names the line and column and which loads nothing; `yaml` 2.9 (ISC), YAML 1.2 with errors at a line and column; and `smol-toml`, the app's TOML reader already, whose errors name the line and column (chosen). Codemirror's parsers give syntax trees of the text rather than values.
- CSV and TSV: a reader of the app's own, RFC 4180's quoted fields, doubled quotes and line breaks within quotes (chosen), rather than Papa Parse, whose streaming and type guessing the table does not need.
- SVG: an image from a data URL (chosen), which draws the picture without running its scripts or loading what it links, as the page's content policy allows. The SVG drawn into the page would run its scripts and leak its styles; a frame would need a policy of its own.
- Large files: trees and tables draw their entries a page at a time, with Show More, rather than all at once or behind a virtual list of their own.

## Decision

The Markdown renderer, with its plugins (ADR-0010) and its delimiters for math, moves to the ui module as `Markdown`, which takes how to draw an image and how to follow a link that is not a web link; the activity draws its data images as thumbnails, as before. The files module recognises a file's format by its name, and a file without an extension as JSON or XML by how its text begins, and renders it in the panel instead of the editor, which stays mounted with its unsaved changes: Markdown with the ui module's renderer, at a document's size, its images beside the file read through the bridge as data where the files module may read them and its links to files opened in panels; JSON, YAML, TOML and XML as one folding tree; CSV and TSV as a table; SVG as an image. A view follows the editor's text as it changes. A parse that fails opens the file raw, and its rendered view says where it fails. The toggle lies in the panel's header, which the panels module gives room for actions.

## Consequences

- Easier: the activity and the files read Markdown alike, and the data formats look alike whatever their syntax.
- Harder: the ui module now holds a renderer with its plugins and styles. The tree and the reader of tables are the app's own to keep, and the window's script grows by about 0.1 MB for `yaml`.
- Must stay true: a rendered view loads nothing from the network, reads only what the files module allows, and runs nothing a file carries.

## Revisit when

Rendered views need editing, or formats the tree and the table cannot hold, such as HTML pages.
