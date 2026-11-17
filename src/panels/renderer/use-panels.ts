import { useMemo, useState, useSyncExternalStore } from 'react';
import type { PanelContent } from '../shared/panels';
import {
  emptyPanels,
  reducePanels,
  type Layout,
  type Move,
  type PanelsAction,
  type PanelsState,
  type PresentChange,
  type Target,
} from './layout';

// The panel area's layout and focused panel, and what changes them: for the area itself, and for
// whatever opens items in it.
export interface Panels {
  layout: Layout | null;
  focusedId: string | null;
  // Opens each item in a panel of its own at the target. Without a target, the items fill the empty
  // area, or else open to the right of the focused panel.
  open(contents: readonly PanelContent[], at?: Target): void;
  // The panel goes on showing something else, as a session page does its session once it starts it.
  show(panelId: string, content: PanelContent): void;
  close(panelId: string): void;
  focus(panelId: string): void;
  resize(splitId: string, ratio: number): void;
  // Moves a panel beside another, or swaps the two.
  move(panelId: string, to: Move): void;
  // Carries out what an agent's presentation asks of the layout.
  present(presentationId: string, change: PresentChange): void;
  // The layout as every change so far has left it, before the area renders it: each change applies
  // at once, so that the presentations' answers can give where their panels lie.
  latest(): PanelsState;
  // Hears every change as it applies; the function returned stops listening.
  subscribe(listener: () => void): () => void;
}

export function usePanels(): Panels {
  const [store] = useState(() => new PanelsStore());
  const state = useSyncExternalStore(store.subscribe, store.get);
  return useMemo(
    () => ({
      layout: state.layout,
      focusedId: state.focusedId,
      open: (contents, at) => {
        store.dispatch({ type: 'open', contents, at });
      },
      show: (panelId, content) => {
        store.dispatch({ type: 'show', panelId, content });
      },
      close: (panelId) => {
        store.dispatch({ type: 'close', panelId });
      },
      focus: (panelId) => {
        store.dispatch({ type: 'focus', panelId });
      },
      resize: (splitId, ratio) => {
        store.dispatch({ type: 'resize', splitId, ratio });
      },
      move: (panelId, to) => {
        store.dispatch({ type: 'move', panelId, to });
      },
      present: (presentationId, change) => {
        store.dispatch({ type: 'present', presentationId, change });
      },
      latest: store.get,
      subscribe: store.subscribe,
    }),
    [state, store],
  );
}

// The layout's state, which each action changes at once, telling those who listen.
class PanelsStore {
  private state = emptyPanels;
  private readonly listeners = new Set<() => void>();

  readonly get = (): PanelsState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch(action: PanelsAction): void {
    const next = reducePanels(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
