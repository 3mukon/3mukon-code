---
id: ADR-0044
type: adr
title: Keep ADR-0043's single setting for Antigravity, but name its modes in the mode menu as the other providers' are, without explaining them there
status: accepted
visibility: public
date: 2026-11-27
summary: Everything ADR-0043 decided stays, from auto as Antigravity's auto mode under its sandbox and yolo with every request approved and no sandbox, a process for each, to the levels they count as; only its promise that the mode chooser says what each mode does in Antigravity goes, since the explanations made the menu's labels too long to read, so the menu names the modes Auto and Yolo and the confirmation before yolo alone says that no sandbox applies
scope: ["src/sessions/**", "src/providers/antigravity/**"]
tags: []
supersedes: [ADR-0043]
superseded_by:
---

## Context

ADR-0043 gives an Antigravity session one setting, auto or yolo, run as Antigravity's own modes. Its Context records the checks it rests on.

Among what must stay true, it promised that "where the user chooses an Antigravity session's mode, and in the confirmation before yolo, the app says that Antigravity's own review, not a sandbox level, decides what its commands reach." The session page kept that promise with mode labels such as "Auto: Antigravity’s own review decides each action, and may run a command outside its sandbox". Its compact menu cuts those labels off, and they say more than a choice of mode needs.

## Options

| Question | Chosen | Rejected | Why |
|---|---|---|---|
| The mode menu | Auto and Yolo, as for every provider | Labels that explain each mode; shorter explanations; an explanation in a tooltip | The explanations made the labels too long for the menu, and a choice of mode reads the same for every provider. Every choice of yolo passes its confirmation, which says what yolo does in Antigravity |

## Decision

Everything ADR-0043 decides stands, with its Context and Options, except its promise about the mode chooser:

- An Antigravity session's mode menu names its modes Auto and Yolo.
- The confirmation before yolo says, in Antigravity's words, that it runs every action without asking and that no sandbox applies.

## Consequences

- **Easier:** the mode menu reads the same for every provider, and nothing in it is cut off.
- **Harder:** the page no longer says that Antigravity's auto mode may leave its sandbox through its own review. The providers page and the Antigravity README say so.
- **Must stay true:** everything ADR-0043 says must stay true, but its promise about the mode chooser. The confirmation before yolo says that no sandbox applies.

## Revisit when

- Anything in ADR-0043's Revisit when happens.
- Users take Antigravity's auto for a mode its sandbox confines.
