import { useMemo, useReducer } from 'react';
import type { PanelContent } from '../shared/panels';
import { emptyPanels, reducePanels, type Layout, type Move, type Target } from './layout';

// The panel area's layout and focused panel, and what changes them: for the area itself, and for
// whatever opens items in it.
export interface Panels {
  layout: Layout | null;
  focusedId: string | null;
  // Opens each item in a panel of its own at the target. Without a target, the items fill the empty
  // area, or else open to the right of the focused panel.
  open(contents: readonly PanelContent[], at?: Target): void;
  close(panelId: string): void;
  focus(panelId: string): void;
  resize(splitId: string, ratio: number): void;
  // Moves a panel beside another, or swaps the two.
  move(panelId: string, to: Move): void;
}

export function usePanels(): Panels {
  const [state, dispatch] = useReducer(reducePanels, emptyPanels);
  return useMemo(
    () => ({
      layout: state.layout,
      focusedId: state.focusedId,
      open: (contents, at) => {
        dispatch({ type: 'open', contents, at });
      },
      close: (panelId) => {
        dispatch({ type: 'close', panelId });
      },
      focus: (panelId) => {
        dispatch({ type: 'focus', panelId });
      },
      resize: (splitId, ratio) => {
        dispatch({ type: 'resize', splitId, ratio });
      },
      move: (panelId, to) => {
        dispatch({ type: 'move', panelId, to });
      },
    }),
    [state],
  );
}
