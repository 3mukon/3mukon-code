import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { Outcome } from '../../sessions/shared/automation';
import type { BrowserTabRef, BrowserTabState } from '../shared/browser';
import type { BrowserViewBounds, BrowserViewDisplay, BrowserViewPlacement } from '../shared/view';
import type { EmbeddedBrowser } from './embedded';
import { refused, type BrowserPage, type MountedBrowserPage } from './page';

const COVER_MS = 100;
const FRAME_DELAY_MS = 200;
const EXTERNAL_FRAME_MS = 750;
const MAX_FRAME_BASE64 = 1024 * 1024;
const MAX_BINDINGS = 32;
const paper: BrowserViewDisplay = { kind: 'paper' };
const verified = <T>(value: T): Outcome<T> => ({ status: 'verified', value });

interface Binding {
  id: string;
  windowId: number;
  owner: string;
  presentation: string;
  tab: BrowserTabRef;
  page: BrowserPage;
  view: MountedBrowserPage | undefined;
  revision: number;
  state: BrowserTabState | null;
  unsubscribe(): void;
  frame: Extract<BrowserViewDisplay, { kind: 'frame' }> | null;
  // Bounds of the last live viewport, in window units.
  liveBounds?: BrowserViewBounds;
  // Where and how dimmed the panel last asked for the live page, which the page takes again once
  // its tab has loaded, since the panel asks again only when its box or its covers change.
  wanted?: { bounds: BrowserViewBounds; dim: string | null };
  pendingFrame?: Promise<void>;
  captureTimer?: ReturnType<typeof setTimeout>;
}

// A binding lends a loaded browser page to an acknowledged presentation. The tab owns its page
// and storage. Moving, hiding or dropping a binding leaves the tab and its operations in place.
export class BrowserViewHost {
  private readonly bindings = new Map<string, Binding>();

  constructor(
    private readonly browser: Pick<EmbeddedBrowser, 'pageForView' | 'subscribe'>,
    private readonly shown: (owner: string, presentation: string, tab: BrowserTabRef) => boolean,
    private readonly observationSignal: (
      owner: string,
      tab: BrowserTabRef,
    ) => AbortSignal | undefined,
  ) {}

  bind(
    window: BrowserWindow,
    owner: string,
    presentation: string,
    tab: BrowserTabRef,
    focused: (id: string) => void,
    fileDragged: (id: string) => void = () => undefined,
  ): Outcome<string> {
    if (!this.shown(owner, presentation, tab)) return refused('not-found');
    const page = this.browser.pageForView(owner, tab);
    if (!page || (!page.mount && !page.openExternal)) return refused('background-unavailable');
    if (page.mount) {
      for (const binding of this.bindings.values()) {
        if (binding.page === page) this.drop(binding);
      }
    }
    if (this.bindings.size >= MAX_BINDINGS) return refused('limit-exceeded');
    const id = randomUUID();
    const windowId = window.webContents.id;
    const stillShown = () => this.bindings.has(id) && this.shown(owner, presentation, tab);
    const entry: Binding = {
      id,
      windowId,
      owner,
      presentation,
      tab,
      page,
      view: page.mount?.(
        window,
        () => {
          if (stillShown()) focused(id);
        },
        () => {
          if (stillShown()) fileDragged(id);
        },
      ),
      revision: 0,
      state: null,
      unsubscribe: () => undefined,
      frame: null,
    };
    this.bindings.set(id, entry);
    const stop = this.browser.subscribe(owner, tab, (state) => {
      if (!state) {
        this.drop(entry);
        return;
      }
      if (!sameViewport(entry.state, state) || state.loading || state.error) entry.frame = null;
      const before = entry.state;
      entry.state = state;
      // While the tab loads or failed, the panel's paper says so, which the page would cover.
      if (!showable(state)) entry.view?.hide();
      else if (before !== null && !showable(before)) void this.reveal(entry);
    });
    if (!this.bindings.has(id)) {
      stop();
      return refused('stale-target');
    }
    entry.unsubscribe = stop;
    return verified(id);
  }

  async place(
    window: BrowserWindow,
    id: string,
    revision: number,
    placement: BrowserViewPlacement,
  ): Promise<Outcome<BrowserViewDisplay>> {
    const entry = this.bindings.get(id);
    if (entry?.windowId !== window.webContents.id) return refused('stale-target');
    if (!this.shown(entry.owner, entry.presentation, entry.tab)) {
      this.drop(entry);
      return refused('stale-target');
    }
    if (revision <= entry.revision) return refused('request-conflict');
    entry.revision = revision;
    clearTimeout(entry.captureTimer);
    const bounds = placement.bounds && windowBounds(window, placement.bounds);
    const current = () => this.bindings.get(id) === entry && entry.revision === revision;
    if (!bounds || this.browser.pageForView(entry.owner, entry.tab) !== entry.page) {
      delete entry.wanted;
      entry.view?.hide();
      return verified(paper);
    }
    if (!entry.view) {
      if (
        !placement.covered &&
        (!entry.frame || Date.now() - entry.frame.capturedAt >= EXTERNAL_FRAME_MS)
      )
        await withinCoverBudget(this.capture(entry));
      return current() ? verified(entry.frame ?? paper) : refused('request-conflict');
    }
    if (placement.covered) {
      delete entry.wanted;
      entry.view.hide();
      // When covered before the first mount, the background viewport need not match this panel.
      if (!entry.liveBounds) return verified(paper);
      await withinCoverBudget(this.capture(entry));
      return current() ? verified(entry.frame ?? paper) : refused('request-conflict');
    }
    entry.wanted = { bounds, dim: placement.dim };
    if (!showable(entry.state)) {
      entry.view.hide();
      return verified(paper);
    }
    const visible = await entry.view.show(bounds, placement.dim);
    if (!current()) return refused('request-conflict');
    if (!visible || this.browser.pageForView(entry.owner, entry.tab) !== entry.page)
      return verified(entry.frame ?? paper);
    entry.liveBounds = bounds;
    // Keep a bounded frame after a show or resize. Repeated layout changes coalesce.
    entry.captureTimer = setTimeout(() => void this.capture(entry), FRAME_DELAY_MS);
    return verified({ kind: 'live' });
  }

  // Lays the page again where its panel last asked for it live, once its tab has loaded, unless the
  // panel has asked for something newer meanwhile.
  private async reveal(entry: Binding): Promise<void> {
    const { wanted, view, revision } = entry;
    if (
      !wanted ||
      !view ||
      !this.shown(entry.owner, entry.presentation, entry.tab) ||
      this.browser.pageForView(entry.owner, entry.tab) !== entry.page
    )
      return;
    const visible = await view.show(wanted.bounds, wanted.dim);
    if (!visible || this.bindings.get(entry.id) !== entry || entry.revision !== revision) return;
    entry.liveBounds = wanted.bounds;
    clearTimeout(entry.captureTimer);
    entry.captureTimer = setTimeout(() => void this.capture(entry), FRAME_DELAY_MS);
  }

  release(window: number, id: string): void {
    const entry = this.bindings.get(id);
    if (entry?.windowId === window) this.drop(entry);
  }

  reconcile(window: number): void {
    for (const entry of this.bindings.values()) {
      if (entry.windowId === window && !this.shown(entry.owner, entry.presentation, entry.tab))
        this.drop(entry);
    }
  }

  disconnect(window: number): void {
    for (const entry of this.bindings.values()) {
      if (entry.windowId === window) this.drop(entry);
    }
  }

  private drop(entry: Binding): void {
    if (!this.bindings.delete(entry.id)) return;
    clearTimeout(entry.captureTimer);
    entry.unsubscribe();
    entry.view?.release();
  }

  private capture(entry: Binding): Promise<void> {
    if (entry.pendingFrame) return entry.pendingFrame;
    const state = entry.state;
    const shown = () => this.shown(entry.owner, entry.presentation, entry.tab);
    if (!state || !shown() || this.browser.pageForView(entry.owner, entry.tab) !== entry.page)
      return Promise.resolve();
    const signal = entry.view ? undefined : this.observationSignal(entry.owner, entry.tab);
    if (!entry.view && (!signal || signal.aborted)) return Promise.resolve();
    entry.pendingFrame = entry.page
      .capture(signal)
      .then((image) => {
        if (
          image &&
          image.image.data.length <= MAX_FRAME_BASE64 &&
          this.bindings.has(entry.id) &&
          shown() &&
          (entry.view ||
            (signal &&
              !signal.aborted &&
              this.observationSignal(entry.owner, entry.tab) === signal)) &&
          this.browser.pageForView(entry.owner, entry.tab) === entry.page &&
          sameViewport(state, entry.state)
        )
          entry.frame = { kind: 'frame', frame: image.image, capturedAt: image.capturedAt };
      })
      .catch(() => undefined)
      .finally(() => {
        delete entry.pendingFrame;
      });
    return entry.pendingFrame;
  }
}

// Whether the tab's page can lie over its panel: loaded, at an address, without an error.
function showable(state: BrowserTabState | null): boolean {
  return !!state && !state.loading && !state.error && !!state.address;
}

function sameViewport(first: BrowserTabState | null, second: BrowserTabState | null): boolean {
  return (
    !!first &&
    !!second &&
    first.documentGeneration === second.documentGeneration &&
    first.geometryGeneration === second.geometryGeneration
  );
}

function windowBounds(window: BrowserWindow, bounds: BrowserViewBounds): BrowserViewBounds | null {
  const [width = 0, height = 0] = window.getContentSize();
  const zoom = window.webContents.getZoomFactor();
  const x = Math.max(0, Math.round(bounds.x * zoom));
  const y = Math.max(0, Math.round(bounds.y * zoom));
  const right = Math.min(width, Math.round((bounds.x + bounds.width) * zoom));
  const bottom = Math.min(height, Math.round((bounds.y + bounds.height) * zoom));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

async function withinCoverBudget(capture: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      capture,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, COVER_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
