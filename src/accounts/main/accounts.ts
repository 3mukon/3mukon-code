import ElectronStore from 'electron-store';
import { z } from 'zod';
import type { ProviderId } from '../../sessions/shared/events';
import type {
  AccountsList,
  ProviderAccount,
  ResetOutcome,
  SignIn,
  Usage,
  UsageProblem,
  UsageWindow,
} from '../shared/accounts';
import type { ProviderInstall } from '../../installs/main/install';
import type { InstallView } from '../../installs/shared/installs';
import type { AccountNews, AccountRead, AccountSource, Program } from './source';

// How old what the app holds of a provider grows before the Accounts panel, while it shows, reads it
// anew, which it checks as often.
export const REFRESH_MS = 5 * 60_000;
// A read this much short of five minutes old counts as five, so that a timer firing early skips none.
const SLACK_MS = 10_000;
// How long the app waits, after a turn reported a failed sign-in, before another such report makes it
// read the sign-in again.
const SIGN_IN_RECHECK_MS = 60_000;

const storedWindow = z.object({
  span: z.union([z.enum(['five-hour', 'day', 'week', 'month']), z.number().positive()]).nullable(),
  model: z.string().min(1).max(200).optional(),
  used: z.number().min(0).max(1_000).nullable(),
  resetsAt: z.number().nullable(),
});
const storedUsage = z.object({
  windows: z.array(storedWindow).max(50),
  resets: z.number().int().nonnegative().optional(),
  readAt: z.number(),
});

export type KeptUsage = Partial<Record<ProviderId, Usage>>;

export interface UsageStorage {
  load(): KeptUsage;
  save(usage: KeptUsage): void;
}

// accounts.json in the folder, the app's data folder (ADR-0039), readable by the user alone: each
// provider's usage limits with when they were read, and nothing else of the account (ADR-0017). A file
// that is not JSON is cleared, and an entry of another shape is left out.
export function usageStorage(folder: string): UsageStorage {
  const store = new ElectronStore<Record<string, unknown>>({
    cwd: folder,
    name: 'accounts',
    configFileMode: 0o600,
    clearInvalidConfig: true,
  });
  return {
    load() {
      const kept = store.store.usage;
      if (typeof kept !== 'object' || kept === null) return {};
      const usage: KeptUsage = {};
      for (const provider of ['claude-code', 'codex', 'grok-build', 'antigravity'] as const) {
        const parsed = storedUsage.safeParse((kept as Record<string, unknown>)[provider]);
        if (parsed.success) usage[provider] = usageOf(parsed.data);
      }
      return usage;
    },
    save(usage) {
      store.store = { usage };
    },
  };
}

function usageOf(stored: z.infer<typeof storedUsage>): Usage {
  return {
    windows: stored.windows.map(({ model, ...window }) => ({
      ...window,
      ...(model === undefined ? {} : { model }),
    })),
    ...(stored.resets === undefined ? {} : { resets: stored.resets }),
    readAt: stored.readAt,
  };
}

// What the accounts ask the user, in the window that asked.
export interface AccountsUi {
  // Asks before one of the provider's resets is spent, saying how many it holds where known; resolves
  // with whether the user confirmed.
  confirmReset(provider: ProviderId, resets: number | undefined): Promise<boolean>;
}

export interface Timers {
  now(): number;
  every(ms: number, run: () => void): () => void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  every(ms, run) {
    const timer = setInterval(run, ms);
    return () => {
      clearInterval(timer);
    };
  },
};

interface Held {
  source: AccountSource;
  // Where the provider's processes come from, and what Accounts shows of it, once read (ADR-0039).
  install?: ProviderInstall;
  installView?: InstallView;
  signIn: SignIn;
  usage?: Usage;
  // Why the last read of the usage could not give it, until one does.
  usageProblem?: UsageProblem;
  // The read under way, which another read waits for instead of asking again.
  reading: Promise<void> | null;
  // When the last read with the usage ended, whatever it found.
  askedAt?: number;
  // When a turn's failed sign-in last made the app read the sign-in.
  recheckedAt?: number;
}

// Each provider's sign-in and a subscription's usage limits, read through its adapter and asked of
// the providers rarely (ADR-0017): every provider once, one at a time, shortly after the window opens;
// then a provider's usage when the Accounts panel shows and what the app holds of it is five minutes
// old, every five minutes while it shows, and after a reset; and its sign-in when a sign-in command
// ends, with the usage, and after a turn fails for want of one. What the providers report while
// sessions run updates the usage without asking. The usage is kept in the app's data, so that a later
// run shows it at once; the sign-in is read anew in each run. Listeners hear every change.
export class Accounts {
  private readonly held: Held[];
  private readonly listeners = new Set<(list: AccountsList) => void>();
  // The windows showing the Accounts panel, and the timer that reads while any does.
  private readonly viewers = new Set<number>();
  private stopTimer: (() => void) | null = null;
  private readonly stopNews: (() => void)[];

  constructor(
    sources: readonly AccountSource[],
    private readonly storage: UsageStorage,
    private readonly timers: Timers = realTimers,
    // Each provider's CLI, by its provider, where the app module gives it.
    installs: readonly ProviderInstall[] = [],
  ) {
    const kept = storage.load();
    this.held = sources.map((source) => {
      const usage = kept[source.id];
      const install = installs.find((candidate) => candidate.provider === source.id);
      return {
        source,
        ...(install === undefined ? {} : { install }),
        signIn: { state: 'unknown' },
        reading: null,
        ...(usage === undefined ? {} : { usage }),
      };
    });
    this.stopNews = this.held.flatMap((held) => [
      held.source.onAccountNews((news) => {
        this.hear(held, news);
      }),
      ...(held.install === undefined
        ? []
        : [
            held.install.onChange((view) => {
              held.installView = view;
              this.changed();
            }),
          ]),
    ]);
  }

  list(): AccountsList {
    return {
      accounts: this.held.map((held): ProviderAccount => ({
        provider: held.source.id,
        signIn: held.signIn,
        ...(held.installView === undefined ? {} : { install: held.installView }),
        ...(held.usage === undefined ? {} : { usage: held.usage }),
        ...(held.usageProblem === undefined ? {} : { usageProblem: held.usageProblem }),
        resettable: held.source.resetLimits !== undefined,
        reading: held.reading !== null,
      })),
    };
  }

  onChange(listener: (list: AccountsList) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Reads every provider whose account the app has not read in five minutes, one at a time: as the
  // window opens, and while the Accounts panel shows.
  async readAll(): Promise<void> {
    for (const held of this.held) {
      if (this.stale(held)) await this.read(held, true);
    }
  }

  // Whether a window shows the Accounts panel, by the window's id.
  setShown(viewer: number, shown: boolean): void {
    const before = this.viewers.size;
    if (shown) this.viewers.add(viewer);
    else this.viewers.delete(viewer);
    if (before === 0 && this.viewers.size > 0) {
      void this.readInstalls();
      void this.readAll();
      this.stopTimer = this.timers.every(REFRESH_MS, () => {
        void this.readAll();
      });
    } else if (before > 0 && this.viewers.size === 0) {
      this.stopTimer?.();
      this.stopTimer = null;
    }
  }

  // Reads the provider's sign-in, and its usage if it is then signed in with a subscription, as its
  // sign-in command ends.
  async readAgain(provider: ProviderId): Promise<void> {
    const held = this.find(provider);
    await held.reading;
    await this.read(held, true);
  }

  // The provider's own sign-in command, which a terminal runs.
  signInCommand(provider: ProviderId): Promise<Program> {
    return this.find(provider).source.signInCommand();
  }

  // Spends one of the provider's resets once the user confirms, then reads its usage anew; resolves
  // with what the reset did, or null when the user did not confirm.
  async reset(provider: ProviderId, ui: AccountsUi): Promise<ResetOutcome | null> {
    const held = this.find(provider);
    const resetLimits = held.source.resetLimits?.bind(held.source);
    if (resetLimits === undefined) throw new Error('This provider offers no reset of its limits.');
    if (!(await ui.confirmReset(provider, held.usage?.resets))) return null;
    const outcome = await resetLimits();
    await held.reading;
    await this.read(held, true);
    return outcome;
  }

  // Reads anew where each provider's processes come from, which asks no provider: as the Accounts panel
  // shows, so that a CLI the user installed or updated shows there.
  async readInstalls(): Promise<void> {
    await Promise.all(this.held.map((held) => this.readInstall(held)));
  }

  // Stops reading and hearing the providers, as the app quits.
  close(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    for (const stop of this.stopNews) stop();
  }

  private find(provider: ProviderId): Held {
    const held = this.held.find((candidate) => candidate.source.id === provider);
    if (held === undefined) throw new Error('The app does not offer this provider.');
    return held;
  }

  private stale(held: Held): boolean {
    return held.askedAt === undefined || this.timers.now() - held.askedAt >= REFRESH_MS - SLACK_MS;
  }

  private async readInstall(held: Held): Promise<void> {
    if (held.install === undefined) return;
    try {
      held.installView = await held.install.view();
      this.changed();
    } catch (error) {
      console.error(`The app could not tell where ${held.source.id} runs from:`, error);
    }
  }

  // Asks the provider, unless a read is under way, which answers instead; a provider that is not
  // installed is not asked, and its sign-in stays unknown. Such a read does not count as one, so that
  // the next read asks the provider once the user has installed it.
  private read(held: Held, withUsage: boolean): Promise<void> {
    if (held.reading !== null) return held.reading;
    const reading = (async () => {
      try {
        await this.readInstall(held);
        if (held.installView?.runs === null) return;
        this.take(held, await held.source.readAccount(withUsage));
      } catch (error) {
        console.error(`The app could not read ${held.source.id}'s account:`, error);
        if (withUsage) held.usageProblem = 'unreachable';
      } finally {
        if (withUsage && held.installView?.runs !== null) held.askedAt = this.timers.now();
      }
    })();
    held.reading = reading;
    this.changed();
    void reading.finally(() => {
      held.reading = null;
      this.changed();
    });
    return reading;
  }

  // Takes what a read found: the sign-in, and the usage, or why it could not be read, which stands
  // until a read or a turn gives the usage; signed out, or signed in another way, the account has no
  // subscription's limits any more.
  private take(held: Held, read: AccountRead): void {
    held.signIn = read.signIn;
    const subscribed = read.signIn.state === 'signed-in' && read.signIn.method === 'subscription';
    if (read.usage !== undefined) {
      held.usage = { ...read.usage, readAt: this.timers.now() };
      delete held.usageProblem;
      this.save();
    } else if (read.usageProblem !== undefined) {
      held.usageProblem = read.usageProblem;
    } else if (!subscribed && read.signIn.state !== 'unknown') {
      delete held.usageProblem;
      if (held.usage !== undefined) {
        delete held.usage;
        this.save();
      }
    }
  }

  private hear(held: Held, news: AccountNews): void {
    if (news.type === 'signed-out') {
      const now = this.timers.now();
      if (held.recheckedAt !== undefined && now - held.recheckedAt < SIGN_IN_RECHECK_MS) return;
      held.recheckedAt = now;
      void this.read(held, false);
      return;
    }
    const windows = [...(held.usage?.windows ?? [])];
    for (const window of news.windows) {
      const same = windows.findIndex((kept) => sameWindow(kept, window));
      if (same === -1) windows.push(window);
      else windows[same] = window;
    }
    const resets = news.resets ?? held.usage?.resets;
    delete held.usageProblem;
    held.usage = {
      windows,
      ...(resets === undefined ? {} : { resets }),
      readAt: this.timers.now(),
    };
    this.save();
    this.changed();
  }

  private save(): void {
    const usage: KeptUsage = {};
    for (const held of this.held) {
      if (held.usage !== undefined) usage[held.source.id] = held.usage;
    }
    this.storage.save(usage);
  }

  private changed(): void {
    const list = this.list();
    for (const listener of this.listeners) listener(list);
  }
}

function sameWindow(a: UsageWindow, b: UsageWindow): boolean {
  return a.span === b.span && a.model === b.model;
}

// An in-memory store, for tests and for a run that keeps nothing.
export function memoryUsageStorage(usage: KeptUsage = {}): UsageStorage {
  let kept = usage;
  return {
    load: () => kept,
    save(next) {
      kept = next;
    },
  };
}
