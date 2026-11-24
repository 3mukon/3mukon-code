import { randomUUID } from 'node:crypto';
import type { Frame, Outcome, TargetRef, TargetSummary } from '../../sessions/shared/automation';
import type {
  BrowserTabCommand,
  BrowserTabRef,
  BrowserTabState,
  BrowserTabs,
} from '../shared/browser';
import {
  type BrowserPage,
  type DialogKind,
  type EmbeddedEngine,
  type ExternalTab,
  type PageAction,
  type PageObservation,
  type PageState,
  type ScriptResult,
  displayAddress,
  refused,
  webAddress,
} from './page';

export const EMBEDDED_BACKEND = 'embedded';
export const EMBEDDED_PROFILE = { id: 'embedded-app', name: 'App browser' } as const;
const SHARED_PARTITION = 'persist:app-browser-v1';
const MAX_TABS = 32;
const MAX_OWNER_TABS = 8;
const BLANK: PageState = {
  address: null,
  title: 'Browser tab',
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  signIn: 'unknown',
};
const okay = (): Outcome<null> => ({ status: 'verified', value: null });
const cancelled = (): Outcome<never> => ({ status: 'cancelled-before-dispatch', effects: 'none' });
export type BrowserIncident = DialogKind | 'popup-activated' | 'target-activated';

export interface BrowserResources {
  register(
    owner: string,
    tab: {
      backend: string;
      key: string;
      kind: 'browser-tab';
      mayActivate: boolean;
      summary: Omit<TargetSummary, 'ref' | 'owner'>;
      release(): Promise<void>;
    },
  ): TargetSummary;
  changed(owner: string, tab: BrowserTabRef, change: 'document' | 'geometry'): void;
  describe(owner: string, tab: BrowserTabRef, name: string, address: string | null): void;
  observation(owner: string, tab: BrowserTabRef): string;
  ended(owner: string, tab: BrowserTabRef, reason: 'tab-closed' | 'backend-lost'): Promise<void>;
  takeover(owner: string, tab: BrowserTabRef): Outcome<null>;
  handBack(owner: string, tab: BrowserTabRef): Outcome<null>;
}

interface Tab {
  state: BrowserTabState;
  create(events: Parameters<EmbeddedEngine['page']>[1]): Promise<BrowserPage>;
  external?: true;
  unwatch?: () => void;
  page?: BrowserPage;
  pendingPage?: Promise<BrowserPage>;
  pending?: true;
  report?: (incident: BrowserIncident) => void;
  observed?: { id: string; marker: string; elements: PageObservation['elements'] };
  listeners: Set<(state: BrowserTabState | null) => void>;
}

type ObservedPage = PageObservation &
  Pick<BrowserTabState, 'address' | 'title' | 'documentGeneration' | 'geometryGeneration'> & {
    observationId: string;
  };

export class EmbeddedBrowser implements BrowserTabs {
  private readonly tabs = new Map<string, Tab>();
  private readonly isolated = new Map<string, string>();
  private clearing: Promise<Outcome<null>> | undefined;
  private closed = false;

  constructor(
    private readonly engine: EmbeddedEngine,
    private readonly resources: BrowserResources,
  ) {}

  // Reserving a handle does not read or open the partition. Its first navigation is a separate
  // broker operation, so an app profile tab cannot start reading a website before its grant.
  open(
    owner: string,
    sharing: 'none' | 'app' | 'global',
    signal: AbortSignal,
    external?: ExternalTab,
  ): Outcome<BrowserTabRef> {
    if (signal.aborted) return cancelled();
    if (this.closed || (sharing === 'app' && this.clearing)) return refused('busy');
    if (sharing === 'global' && !external) return refused('background-unavailable');
    const browser = external?.browser ?? EMBEDDED_BACKEND;
    if (
      this.tabs.size >= MAX_TABS ||
      [...this.tabs.values()].filter((tab) => tab.state.owner === owner).length >= MAX_OWNER_TABS
    )
      return refused('limit-exceeded');
    const key = randomUUID();
    const profile = external?.profile ?? (sharing === 'app' ? EMBEDDED_PROFILE : null);
    const target = this.resources.register(owner, {
      backend: browser,
      key,
      kind: 'browser-tab',
      mayActivate: !!external,
      summary: { name: BLANK.title, browser, sharing, ...(profile ? { profile } : {}) },
      release: async () => {
        await this.release(target.ref.id);
      },
    });
    const ref: BrowserTabRef = { ...target.ref, kind: 'browser-tab' };
    const partition =
      sharing === 'app' ? SHARED_PARTITION : (this.isolated.get(owner) ?? 'browser-' + key);
    if (sharing === 'none') this.isolated.set(owner, partition);
    const tab: Tab = {
      state: {
        ...BLANK,
        ref,
        owner,
        browser,
        sharing,
        profile,
        documentGeneration: 0,
        geometryGeneration: 0,
        control: 'agent',
      },
      create: (events) => (external ? external.page(events) : this.engine.page(partition, events)),
      listeners: new Set(),
    };
    this.tabs.set(ref.id, tab);
    if (external) {
      tab.external = true;
      tab.unwatch = external.onEnd(() => {
        if (this.find(owner, ref)) void this.resources.ended(owner, ref, 'backend-lost');
      });
    }
    return { status: 'verified', value: { ...ref } };
  }

  isExternal(owner: string, ref: BrowserTabRef): boolean {
    return this.find(owner, ref)?.external === true;
  }

  async closeTab(owner: string, ref: TargetRef): Promise<Outcome<null>> {
    const tab = this.find(owner, ref);
    if (!tab) return refused('stale-target');
    if (tab.state.control === 'user') return refused('target-paused');
    await this.resources.ended(owner, tab.state.ref, 'tab-closed');
    return okay();
  }

  tabRef(owner: string, id: string): BrowserTabRef | null {
    const tab = this.tabs.get(id);
    return tab?.state.owner === owner ? { ...tab.state.ref } : null;
  }

  pageForView(owner: string, ref: BrowserTabRef): BrowserPage | null {
    const tab = this.find(owner, ref);
    if (tab?.state.address && !tab.state.loading && tab.state.error === null)
      return tab.page ?? null;
    return null;
  }

  snapshot(owner: string, ref: BrowserTabRef): Promise<BrowserTabState | null> {
    return Promise.resolve(structuredClone(this.find(owner, ref)?.state ?? null));
  }

  subscribe(owner: string, ref: BrowserTabRef, listener: (state: BrowserTabState | null) => void) {
    const tab = this.find(owner, ref);
    listener(structuredClone(tab?.state ?? null));
    tab?.listeners.add(listener);
    return () => {
      tab?.listeners.delete(listener);
    };
  }

  async command(
    owner: string,
    ref: BrowserTabRef,
    command: BrowserTabCommand,
  ): Promise<Outcome<null>> {
    const tab = this.find(owner, ref);
    if (!tab) return refused('stale-target');
    if (command.kind === 'close') {
      // The user's Close ends the tab and the agent's use of it, whoever has the tab, as closing the
      // session would; a Chrome task tab the user took over stays open in Chrome as the user's own.
      await this.resources.ended(owner, tab.state.ref, 'tab-closed');
      return okay();
    }
    if (command.kind === 'open-external') {
      if (!tab.page?.openExternal) return refused('background-unavailable');
      const taken = this.setControl(tab, 'user');
      if (taken.status !== 'verified') return taken;
      if (tab.pending) return refused('busy');
      tab.pending = true;
      try {
        return await tab.page.openExternal();
      } finally {
        delete tab.pending;
      }
    }
    if (command.kind === 'hand-back') {
      if (tab.pending) return refused('busy');
      return this.setControl(tab, 'agent');
    }
    if (tab.external && command.kind !== 'take-control') return refused('invalid-request');
    const taken = this.setControl(tab, 'user');
    if (taken.status !== 'verified' || command.kind === 'take-control') return taken;
    if (command.kind === 'stop-loading')
      return tab.page?.navigate(command, new AbortController().signal) ?? okay();
    if (tab.pending) return refused('busy');
    const signal = new AbortController().signal;
    return this.run(
      tab,
      signal,
      () => undefined,
      (page) => page.navigate(command, signal),
      command.kind === 'navigate',
    );
  }

  navigate(
    owner: string,
    ref: BrowserTabRef,
    url: string,
    signal: AbortSignal,
    dialog: (incident: BrowserIncident) => void,
  ): Promise<Outcome<null>> {
    if (!webAddress(url)) return Promise.resolve(refused('invalid-request'));
    const tab = this.find(owner, ref);
    if (!tab) return Promise.resolve(refused('stale-target'));
    return this.agentRun(
      tab,
      signal,
      dialog,
      (page) => page.navigate({ kind: 'navigate', url }, signal),
      true,
    );
  }

  observe(
    owner: string,
    ref: BrowserTabRef,
    signal: AbortSignal,
    dialog: (incident: BrowserIncident) => void,
  ): Promise<Outcome<ObservedPage>> {
    const tab = this.find(owner, ref);
    if (!tab) return Promise.resolve(refused('stale-target'));
    return this.agentRun(tab, signal, dialog, async (page) => {
      const marker = randomUUID();
      const { documentGeneration, geometryGeneration } = tab.state;
      const value = await page.observe(marker, signal);
      if (signal.aborted) return cancelled();
      if (!this.current(tab, documentGeneration, geometryGeneration))
        return refused('stale-observation');
      const observationId = this.resources.observation(owner, ref);
      tab.observed = { marker, id: observationId, elements: value.elements };
      return {
        status: 'verified',
        value: {
          ...value,
          address: tab.state.address,
          title: tab.state.title,
          documentGeneration,
          geometryGeneration,
          observationId,
        },
      };
    });
  }

  capture(
    owner: string,
    ref: BrowserTabRef,
    signal: AbortSignal,
    dialog: (incident: BrowserIncident) => void,
  ): Promise<Outcome<Frame>> {
    const tab = this.find(owner, ref);
    if (!tab) return Promise.resolve(refused('stale-target'));
    return this.agentRun(tab, signal, dialog, async (page) => {
      const { documentGeneration, geometryGeneration } = tab.state;
      const frame = await page.capture(signal);
      if (signal.aborted) return cancelled();
      if (!this.current(tab, documentGeneration, geometryGeneration))
        return refused('stale-observation');
      if (!frame) return refused('background-unavailable');
      return {
        status: 'verified',
        value: {
          target: ref,
          observationId: this.resources.observation(owner, ref),
          documentGeneration,
          geometryGeneration,
          capturedAt: frame.capturedAt,
          image: frame.image,
          imageSize: { width: frame.width, height: frame.height },
          viewport: { x: 0, y: 0, ...frame.viewport },
          units: 'css-pixels',
          imageToViewport: [
            frame.viewport.width / frame.width,
            0,
            0,
            frame.viewport.height / frame.height,
            0,
            0,
          ],
        },
      };
    });
  }

  actionLabel(owner: string, ref: BrowserTabRef, observationId: string, element: number) {
    const observed = this.find(owner, ref)?.observed;
    if (observed?.id === observationId)
      return observed.elements.find((control) => control.ref === element)?.label;
  }

  async action(
    owner: string,
    ref: BrowserTabRef,
    observationId: string,
    action: PageAction,
    signal: AbortSignal,
    dialog: (incident: BrowserIncident) => void,
  ): Promise<Outcome<null>> {
    const tab = this.find(owner, ref);
    if (!tab) return refused('stale-target');
    return this.agentRun(tab, signal, dialog, (page) => {
      const observed = tab.observed;
      if (observed?.id !== observationId) return Promise.resolve(refused('stale-observation'));
      delete tab.observed;
      return page.action(observed.marker, action, signal);
    });
  }

  // Runs an agent's script in its tab's page; a script may change the page, so the agent's last
  // observation no longer serves an action.
  runScript(
    owner: string,
    ref: BrowserTabRef,
    script: string,
    timeoutMs: number,
    signal: AbortSignal,
    dialog: (incident: BrowserIncident) => void,
  ): Promise<Outcome<ScriptResult>> {
    const tab = this.find(owner, ref);
    if (!tab) return Promise.resolve(refused('stale-target'));
    return this.agentRun(tab, signal, dialog, (page) => {
      delete tab.observed;
      return page.runScript(script, timeoutMs, signal);
    });
  }

  clearAppSignIns(): Promise<Outcome<null>> {
    if (this.closed) return Promise.resolve(refused('connection-lost'));
    // Revoke tabs first, so a running page or service worker cannot repopulate the cleared store.
    this.clearing ??= Promise.resolve()
      .then(async () => {
        await Promise.all(
          [...this.tabs.values()]
            .filter((t) => t.state.sharing === 'app')
            .map((t) => this.resources.ended(t.state.owner, t.state.ref, 'tab-closed')),
        );
        await this.engine.clear(SHARED_PARTITION);
        return okay();
      })
      .catch(() => refused<null>('connection-lost'))
      .finally(() => {
        this.clearing = undefined;
      });
    return this.clearing;
  }

  async closeOwner(owner: string): Promise<void> {
    const partition = this.isolated.get(owner);
    if (!partition) return;
    this.isolated.delete(owner);
    await this.engine.clear(partition);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.tabs.keys()].map((id) => this.release(id)));
    await Promise.allSettled([...this.isolated.keys()].map((owner) => this.closeOwner(owner)));
    await this.clearing;
  }

  private find(owner: string, ref: TargetRef): Tab | undefined {
    const tab = this.tabs.get(ref.id);
    if (
      tab?.state.owner === owner &&
      ref.kind === 'browser-tab' &&
      tab.state.ref.generation === ref.generation
    )
      return tab;
  }

  private setControl(tab: Tab, control: Tab['state']['control']): Outcome<null> {
    const { owner, ref } = tab.state;
    const outcome =
      control === 'user'
        ? this.resources.takeover(owner, ref)
        : this.resources.handBack(owner, ref);
    if (outcome.status === 'verified' && tab.state.control !== control) {
      tab.state.control = control;
      delete tab.observed;
      delete tab.report;
      this.publish(tab);
    }
    return outcome;
  }

  private agentRun<T>(
    tab: Tab,
    signal: AbortSignal,
    dialog: (incident: BrowserIncident) => void,
    action: (page: BrowserPage) => Promise<Outcome<T>>,
    create = false,
  ): Promise<Outcome<T>> {
    if (tab.state.control === 'user') return Promise.resolve(refused('target-paused'));
    // An external task tab opens blank; nothing but its first navigation may use it.
    if (!create && tab.external && tab.state.documentGeneration === 0)
      return Promise.resolve(refused('not-found'));
    if (tab.state.loading && !create) return Promise.resolve(refused('busy'));
    return this.run(tab, signal, dialog, action, create || !!tab.external);
  }

  private async run<T>(
    tab: Tab,
    signal: AbortSignal,
    dialog: (incident: BrowserIncident) => void,
    action: (page: BrowserPage) => Promise<Outcome<T>>,
    create: boolean,
  ): Promise<Outcome<T>> {
    const aborted = () => signal.aborted;
    if (aborted()) return cancelled();
    if (this.closed || (this.clearing && tab.state.sharing === 'app')) return refused('busy');
    if (tab.pending) return refused('busy');
    tab.pending = true;
    tab.report = dialog;
    try {
      const page = tab.page ?? (create ? await this.makePage(tab) : undefined);
      if (aborted()) return cancelled();
      if (!this.find(tab.state.owner, tab.state.ref)) return refused('stale-target');
      if (!page) return refused('not-found');
      return await action(page);
    } catch (error) {
      if (tab.external) return refused('connection-lost');
      throw error;
    } finally {
      delete tab.pending;
    }
  }

  private async makePage(tab: Tab): Promise<BrowserPage> {
    const { owner, ref } = tab.state;
    const starting = tab.create({
      change: (state, change) => {
        if (!this.find(owner, ref)) return;
        const previous = tab.state;
        tab.state = {
          ...previous,
          ...state,
          title: state.title.slice(0, 256),
          address: state.address === null ? null : displayAddress(state.address),
          documentGeneration: previous.documentGeneration + (change === 'document' ? 1 : 0),
          geometryGeneration: previous.geometryGeneration + (change === 'geometry' ? 1 : 0),
        };
        if (change) {
          delete tab.observed;
          this.resources.changed(owner, ref, change);
        }
        this.resources.describe(owner, ref, tab.state.title, tab.state.address);
        this.publish(tab);
      },
      dialog: (kind) => {
        if (this.find(owner, ref)) tab.report?.(kind);
      },
      popup: () => {
        if (this.find(owner, ref)) tab.report?.('popup-activated');
      },
      activated: () => {
        if (this.find(owner, ref)) tab.report?.('target-activated');
      },
      ended: () => {
        if (this.find(owner, ref)) void this.resources.ended(owner, ref, 'backend-lost');
      },
      userInput: () => {
        if (!this.find(owner, ref)) return false;
        return tab.state.control === 'user' || this.setControl(tab, 'user').status === 'verified';
      },
    });
    tab.pendingPage = starting;
    try {
      const page = await starting;
      if (this.find(owner, ref)) tab.page = page;
      return page;
    } finally {
      delete tab.pendingPage;
    }
  }

  private current(tab: Tab, document: number, geometry: number): boolean {
    return (
      !!this.find(tab.state.owner, tab.state.ref) &&
      tab.state.documentGeneration === document &&
      tab.state.geometryGeneration === geometry
    );
  }

  private publish(tab: Tab): void {
    for (const listener of [...tab.listeners]) listener(structuredClone(tab.state));
  }

  private async release(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    tab.unwatch?.();
    for (const listener of [...tab.listeners]) listener(null);
    tab.listeners.clear();
    await tab.page?.close();
    if (tab.pendingPage) {
      const page = await tab.pendingPage.catch(() => undefined);
      await page?.close();
    }
  }
}
