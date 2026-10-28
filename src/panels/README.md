---
id: DOC-mod-panels
type: doc
title: panels module
status: current
visibility: public
date: 2026-10-27
summary: The main area's flexible layout of panels, which split side by side or stacked, nest, resize, take focus and close from the pointer and the keyboard, and open the folders and files dropped from the trees and the Finder
scope: ["src/panels/**"]
tags: []
---

## Responsibilities

- The layout (`renderer/layout.ts`): a tree whose leaves are panels and whose other nodes split their space in two, side by side or stacked, each giving its first part a share of it. `reducePanels` opens items, filling the empty area, beside a panel or in a panel's place; closes a panel, whose space goes to the rest of its split and whose focus passes to the nearest panel there; moves a panel beside another or swaps the two; focuses a panel; and resizes a split. A panel shows a session page for a folder, or a file (`PanelContent` in `shared/panels.ts`).
- `usePanels` (`renderer/use-panels.ts`): the layout and the focused panel as React state, with what changes them, for the area itself and for whatever opens items in it.
- `PanelArea` (`renderer/panel-area.tsx`), the main area:
  - Each panel takes its box in the area (`arrange` in `renderer/geometry.ts`), and the panels stay in the page in the order they were opened, so that a split or a close never moves a panel's content elsewhere in the page and nothing in it starts over. Each split gets the ui module's divider.
  - Each panel is the ui module's pane: a session page goes by New session and a file by its name, each with its folder's name and the full path as the tooltip, and a close button. The focused panel is marked current and the others dim. The bodies stay empty until session pages and the file editor fill them.
  - The area starts at the window's top edge: the headers of the panels at the top lie in the title bar and move the window from their empty part, and the header under macOS's window buttons, which lie over the area while the sidebar is hidden, leaves room for them. While no panel is open, an empty strip there moves the window.
  - Drops: a folder or file dragged from one of the app's trees (`renderer/item-drag.ts`) or from the Finder fills the empty area; near a panel's edge, within a quarter of its width or height, it splits the panel and opens on that side; in its middle it takes the panel's place. A highlight shows where. Several items open one beside the other. Finder items reach the main process as the paths of their files, and come back as folders and files.
  - Moving: a panel dragged by its title and folder name onto another panel moves beside it near its edge, leaving its place as a close does, and in its middle the two swap places; it never drops on itself. A moved panel keeps its id, so what it shows does not start over.
  - The keyboard, from anywhere in the window: ⌘D splits the focused panel to the right and ⇧⌘D downwards, opening a session page in its folder; ⌘W closes the focused panel; ⌘1 to ⌘9 focus the panels in reading order; ⌥⌘ and an arrow focus the next panel that way, and ⇧⌥⌘ and an arrow swap the focused panel with it. The keyboard focus follows the focused panel. Dividers take focus with Tab and move with the arrow keys. While no panel is open, these keys are left to the window, so that ⌘W closes it.
- Dropped items (`main/items.ts`): `droppedItems` tells the folders from the files among the paths of items dropped from the Finder, a link counting as what it points to, and leaves out relative paths and anything missing or neither.
- The contract (`shared/panels.ts`): `PanelContent`, `DroppedItem`, and `PanelsBridge`, what the window asks of this module through the preload bridge.

## Not responsible for

- What a panel's body shows: the sessions module fills session pages and sessions, and the files module the file editor.
- Reading files, or checking that a file lies inside a workspace or was dropped: the files module does when it opens one.
- Starting drags from the trees: the workspaces module does, and the app module gives its drags this module's format.
- Tabs inside a panel, and keeping the layout across a restart, which are deferred.

## Interface

- For the app module: `PanelArea`, `usePanels` and `Panels`, `contentOf` and `writeItemDrag` from `renderer/`; `droppedItems` from `main/items.ts`.
- For both processes: the types in `shared/panels.ts`.

## Dependencies

- Uses the ui and i18n modules, React and react-i18next, and in `main/` Node.js built-ins. The rule `panels-only-to-ui-and-i18n` in `.dependency-cruiser.js` enforces it.
- Only the app module imports it.

## Invariants

- A panel keeps its id while it is open, and the panels stay in the page in the order they were opened.
- Items reach panels by absolute path only; a drag from a tree carries the path of a row inside a workspace.
- The layout, its geometry and the drag format have unit tests (`renderer/*.test.ts`); the area is rendered with a fake bridge (`renderer/panel-area.test.tsx`); dropped items are checked on real folders (`main/items.test.ts`); and a smoke test drags tree rows into the built app's main area, works its panels from the keyboard and moves them (`tests/smoke/panels.spec.ts`).
