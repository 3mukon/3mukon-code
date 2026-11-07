---
id: ADR-0021
type: adr
title: Draw tooltips in the window's page, in the app's own look, from the titles the controls already carry
status: accepted
visibility: public
date: 2026-11-06
summary: One host in the page draws the window's tooltips, while a setting that starts off allows them, as a sheet of the paper under a dashed line, from the `title` each control already carries, which waits aside while the pointer is over it so that macOS's own tooltip stays away, because Electron shows macOS's tooltips only now and then and they cannot take the e-ink look; macOS's own tooltips, a tooltip at each control and a tooltip library were rejected
scope: ["src/ui/renderer/**", "src/app/renderer/**", "src/settings/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

Icon buttons and other controls across the window name themselves in a `title`, which macOS draws as a tooltip, beside their `aria-label`: 35 of them in 22 files, from the title bar's buttons and the panes' close buttons to the editor's search bar. In the app, macOS's tooltips did not show reliably: the search bar's icons showed none on hover, and in Electron on macOS they are reported to show after a varying delay, to hide on their own and not to show again. Where they do show, they are macOS's own boxes, which cannot take the window's e-ink look, as the menus and questions could not before ADR-0013.

## Options

- One tooltip host in the page that draws the titles (chosen): mounted once, it follows the pointer and the keyboard's focus over the whole window and draws the `title` of the element under them, so that no control changes; while the pointer is over an element, its title waits aside in a data attribute, so that macOS's own tooltip does not show as well.
- macOS's own tooltips (the first design): no code, and the system's timing; but in Electron they show only now and then, and in macOS's look.
- A tooltip at each control, a component or an attribute of the app's own in place of `title`: explicit; but every titled control in eight modules changes, and each would have to keep its description for VoiceOver by hand where its title said more than its name.
- A tooltip library, such as Floating UI's or Radix's: placement handled; but a dependency, and the same change at every control.

## Decision

The ui module's `TooltipHost`, which the app module mounts once beside the prompts' host, draws the tooltip of the element whose `title` the pointer rests on for half a second, or which the keyboard focuses: a sheet of the window's paper under a dashed line, in small type, below the element and centred on it, or above it near the window's foot, always inside the window, and hidden from VoiceOver, which reads the element's own name. Moving on to the next titled element within a moment names it at once. A press, the wheel, Escape, the window losing the focus or the element going hides it, and an element pressed shows none until the pointer leaves it. While the pointer is over an element, its title waits in `data-tooltip-title` and comes back as the pointer leaves; a title React sets meanwhile, as a label changes, moves aside too and updates the tooltip.

The tooltips show only while the Tooltips setting is on, which it is not until the user turns it on in the settings, so that a window used every day stays quiet. While it is off, the host still sets the title of the element under the pointer aside, so that no tooltip of macOS's shows in their stead.

## Consequences

- Easier: every titled control has a tooltip that shows once they are turned on, in the e-ink look in both appearances, without a change to the control; a smoke test can see one.
- Harder: the tooltips' timing and placement are the app's to keep, where macOS gave them; code that reads an element's `title` while the pointer is over it finds it in `data-tooltip-title` instead.
- Must stay true: controls keep naming themselves in `title` beside their `aria-label`; a tooltip never takes the focus or the pointer; its text shows as text.

## Revisit when

- Electron shows macOS's tooltips reliably and their look no longer stands out, or the window needs tooltips that hold more than text.
