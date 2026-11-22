import type { Outcome } from '../../sessions/shared/automation';
import type { MessageImage } from '../../sessions/shared/events';
import type { BrowserTabRef, BrowserTabs } from './browser';

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserViewPlacement {
  // CSS pixels relative to the app's main frame. Main converts and clips to the window.
  bounds: BrowserViewBounds | null;
  covered: boolean;
  // The paper color as #RRGGBB at the unfocused panel's opacity.
  dim: string | null;
}

export type BrowserViewDisplay =
  { kind: 'live' | 'paper' } | { kind: 'frame'; frame: MessageImage; capturedAt: number };

export interface BrowserViews {
  bind(owner: string, presentation: string, tab: BrowserTabRef): Promise<Outcome<string>>;
  place(
    binding: string,
    revision: number,
    placement: BrowserViewPlacement,
  ): Promise<Outcome<BrowserViewDisplay>>;
  release(binding: string): Promise<void>;
  onFocus(listener: (binding: string) => void): () => void;
  onFileDrag(listener: (binding: string) => void): () => void;
}

export interface BrowserBridge extends BrowserTabs, BrowserViews {
  tabRef(owner: string, id: string): Promise<BrowserTabRef | null>;
}
