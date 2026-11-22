import type { BrowserWindow } from 'electron';
import type { MessageImage } from '../../sessions/shared/events';
import type { Outcome, RefusalDetail } from '../../sessions/shared/automation';
import type { BrowserNavigation, BrowserTabState } from '../shared/browser';
import type { BrowserViewBounds } from '../shared/view';

export type PageState = Pick<
  BrowserTabState,
  'address' | 'title' | 'loading' | 'error' | 'canGoBack' | 'canGoForward' | 'signIn'
>;

export interface PageObservation {
  width: number;
  height: number;
  text: string;
  truncated: boolean;
  elements: { ref: number; role: string; label: string }[];
}
export type PageAction =
  | { kind: 'click'; element: number }
  | { kind: 'type'; element: number; text: string }
  | { kind: 'scroll'; deltaY: number };

export interface PageCapture {
  image: MessageImage;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  capturedAt: number;
}

export type DialogKind = 'alert' | 'confirm' | 'prompt';
export interface MountedBrowserPage {
  show(bounds: BrowserViewBounds, dim: string | null): Promise<boolean>;
  hide(): void;
  release(): void;
}

export interface BrowserPage {
  navigate(command: BrowserNavigation, signal: AbortSignal): Promise<Outcome<null>>;
  observe(marker: string, signal?: AbortSignal): Promise<PageObservation>;
  capture(signal?: AbortSignal): Promise<PageCapture | null>;
  action(marker: string, action: PageAction, signal?: AbortSignal): Promise<Outcome<null>>;
  openExternal?(): Promise<Outcome<null>>;
  mount?(window: BrowserWindow, focused: () => void, fileDragged: () => void): MountedBrowserPage;
  close(): Promise<void>;
}
export interface PageEvents {
  change(state: PageState, generation?: 'document' | 'geometry'): void;
  dialog(kind: DialogKind): void;
  ended(): void;
  popup?(): void;
  activated?(): void;
  userInput(): boolean;
}
// A task tab in the connected Chrome profile, opened blank: its first use is a navigation.
export interface ExternalTab {
  browser: 'chrome';
  profile: NonNullable<BrowserTabState['profile']>;
  page(events: PageEvents): Promise<BrowserPage>;
  onEnd(listener: () => void): () => void;
}
export interface EmbeddedEngine {
  page(partition: string, events: PageEvents): Promise<BrowserPage>;
  clear(partition: string): Promise<void>;
}

export function webAddress(raw: string): URL | null {
  if (raw.length > 4096) return null;
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code <= 32 || code === 127) return null;
  }
  try {
    const url = new URL(raw);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password)
      return url;
  } catch {
    // Invalid addresses have no navigation target.
  }
  return null;
}

export function displayAddress(raw: string): string | null {
  const url = webAddress(raw);
  return url ? (url.origin + url.pathname).slice(0, 2048) : null;
}

export const refused = <T = never>(
  code: Extract<Outcome, { status: 'refused' }>['code'],
  detail?: RefusalDetail,
): Outcome<T> => ({ status: 'refused', code, dispatched: false, ...(detail ? { detail } : {}) });
