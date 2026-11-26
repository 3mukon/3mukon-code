import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInstall } from '../../installs/main/install';
import type { InstallView } from '../../installs/shared/installs';
import type { ProviderId } from '../../sessions/shared/events';
import type { UsageWindow } from '../shared/accounts';
import {
  Accounts,
  memoryUsageStorage,
  REFRESH_MS,
  usageStorage,
  type AccountsUi,
  type KeptUsage,
  type Timers,
} from './accounts';
import type { AccountNews, AccountRead, AccountSource } from './source';

const fiveHour = (used: number): UsageWindow => ({ span: 'five-hour', used, resetsAt: 1_000 });
const weekly: UsageWindow = { span: 'week', used: 20, resetsAt: 9_000 };
const subscribed: AccountRead = {
  signIn: { state: 'signed-in', method: 'subscription' },
  usage: { windows: [fiveHour(40), weekly] },
};

// A provider whose answers the test gives, which records what it was asked.
function source(id: ProviderId, answer: () => Promise<AccountRead>, resettable = false) {
  const asked: boolean[] = [];
  const listeners = new Set<(news: AccountNews) => void>();
  const reset = vi.fn(() => Promise.resolve('reset' as const));
  const fake: AccountSource = {
    id,
    readAccount(withUsage) {
      asked.push(withUsage);
      return answer();
    },
    signInCommand: () => Promise.resolve({ file: `/bin/${id}`, args: ['login'] }),
    onAccountNews(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ...(resettable ? { resetLimits: reset } : {}),
  };
  return {
    fake,
    asked,
    reset,
    tell: (news: AccountNews) => {
      for (const listener of listeners) listener(news);
    },
  };
}

// A clock the test moves on, and a timer it fires.
function clock(start = 1_000_000) {
  let now = start;
  const timers = new Set<() => void>();
  const fake: Timers = {
    now: () => now,
    every(_ms, run) {
      timers.add(run);
      return () => {
        timers.delete(run);
      };
    },
  };
  return {
    fake,
    pass(ms: number) {
      now += ms;
    },
    fire() {
      for (const run of timers) run();
    },
    running: () => timers.size,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A provider's CLI whose view the test sets, and tells of a change.
function install(provider: ProviderId, view: InstallView) {
  let current = view;
  const listeners = new Set<(view: InstallView) => void>();
  const fake: ProviderInstall = {
    provider,
    current: () => Promise.reject(new Error('not run here')),
    prepare: () => Promise.reject(new Error('not run here')),
    view: () => Promise.resolve(current),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    fake,
    set(next: InstallView) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('Accounts', () => {
  it('shows the usage kept from an earlier run at once, with the sign-in unknown until read', () => {
    const kept: KeptUsage = { codex: { windows: [fiveHour(85)], resets: 2, readAt: 5 } };
    const accounts = new Accounts(
      [
        source('claude-code', () => Promise.resolve(subscribed)).fake,
        source('codex', () => Promise.resolve(subscribed), true).fake,
      ],
      memoryUsageStorage(kept),
    );
    expect(accounts.list().accounts).toEqual([
      { provider: 'claude-code', signIn: { state: 'unknown' }, resettable: false, reading: false },
      {
        provider: 'codex',
        signIn: { state: 'unknown' },
        usage: kept.codex,
        resettable: true,
        reading: false,
      },
    ]);
  });

  it('reads every provider once, one at a time, and keeps the usage with when it was read', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const claude = source('claude-code', async () => {
      order.push('claude-code');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return subscribed;
    });
    const grok = source('grok-build', () => {
      order.push('grok-build');
      return Promise.resolve({ signIn: { state: 'signed-out' } });
    });
    const storage = memoryUsageStorage();
    const time = clock();
    const accounts = new Accounts([claude.fake, grok.fake], storage, time.fake);
    const heard = vi.fn();
    accounts.onChange(heard);
    const reading = accounts.readAll();
    await settle();
    expect(order).toEqual(['claude-code']);
    expect(accounts.list().accounts[0]?.reading).toBe(true);
    release();
    await reading;
    expect(order).toEqual(['claude-code', 'grok-build']);
    expect(claude.asked).toEqual([true]);
    expect(accounts.list().accounts.map((account) => account.signIn)).toEqual([
      { state: 'signed-in', method: 'subscription' },
      { state: 'signed-out' },
    ]);
    expect(storage.load()).toEqual({
      'claude-code': { windows: [fiveHour(40), weekly], readAt: 1_000_000 },
    });
    expect(heard).toHaveBeenCalled();
    // Read within five minutes, they are not read again.
    time.pass(REFRESH_MS / 2);
    await accounts.readAll();
    expect(claude.asked).toEqual([true]);
  });

  it('drops the usage of a provider no longer signed in with a subscription, and keeps it, saying why, when a read fails', async () => {
    let answer: () => Promise<AccountRead> = () =>
      Promise.reject(new Error('Codex did not start.'));
    const codex = source('codex', () => answer());
    const storage = memoryUsageStorage({ codex: { windows: [weekly], readAt: 1 } });
    const time = clock();
    const accounts = new Accounts([codex.fake], storage, time.fake);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await accounts.readAll();
    expect(accounts.list().accounts[0]).toMatchObject({
      signIn: { state: 'unknown' },
      usage: { windows: [weekly] },
      usageProblem: 'unreachable',
    });
    // The provider answers that it could not fetch the usage for its sign-in.
    answer = () =>
      Promise.resolve({
        signIn: { state: 'signed-in', method: 'subscription' },
        usageProblem: 'refused',
      });
    time.pass(REFRESH_MS);
    await accounts.readAll();
    expect(accounts.list().accounts[0]).toMatchObject({
      usage: { windows: [weekly] },
      usageProblem: 'refused',
    });
    // A turn that reports a window clears it.
    codex.tell({ type: 'usage', windows: [fiveHour(10)] });
    expect(accounts.list().accounts[0]?.usageProblem).toBeUndefined();
    answer = () => Promise.resolve({ signIn: { state: 'signed-in', method: 'key' } });
    time.pass(REFRESH_MS);
    await accounts.readAll();
    expect(accounts.list().accounts[0]?.usage).toBeUndefined();
    expect(accounts.list().accounts[0]?.usageProblem).toBeUndefined();
    expect(storage.load()).toEqual({});
  });

  it('reads anew what is five minutes old while a window shows the panel, every five minutes, and stops once none does', async () => {
    const claude = source('claude-code', () => Promise.resolve(subscribed));
    const time = clock();
    const accounts = new Accounts([claude.fake], memoryUsageStorage(), time.fake);
    accounts.setShown(1, true);
    await settle();
    expect(claude.asked).toEqual([true]);
    // A second window showing it starts nothing more.
    accounts.setShown(2, true);
    await settle();
    expect(claude.asked).toEqual([true]);
    time.pass(REFRESH_MS);
    time.fire();
    await settle();
    expect(claude.asked).toEqual([true, true]);
    accounts.setShown(1, false);
    accounts.setShown(2, false);
    expect(time.running()).toBe(0);
  });

  it('merges the windows turns report, and reads the sign-in again after a failed one, once a minute at most', async () => {
    const claude = source('claude-code', () => Promise.resolve(subscribed));
    const time = clock();
    const storage = memoryUsageStorage();
    const accounts = new Accounts([claude.fake], storage, time.fake);
    await accounts.readAll();
    time.pass(1_000);
    claude.tell({
      type: 'usage',
      windows: [fiveHour(90), { span: 'week', model: 'Opus', used: 5, resetsAt: null }],
    });
    expect(accounts.list().accounts[0]?.usage).toEqual({
      windows: [fiveHour(90), weekly, { span: 'week', model: 'Opus', used: 5, resetsAt: null }],
      readAt: 1_001_000,
    });
    expect(storage.load()['claude-code']?.windows[0]).toEqual(fiveHour(90));
    claude.tell({ type: 'signed-out' });
    claude.tell({ type: 'signed-out' });
    await settle();
    expect(claude.asked).toEqual([true, false]);
    time.pass(60_000);
    claude.tell({ type: 'signed-out' });
    await settle();
    expect(claude.asked).toEqual([true, false, false]);
  });

  it('reads the sign-in with the usage again once a sign-in command ends, and gives that command', async () => {
    const grok = source('grok-build', () => Promise.resolve(subscribed));
    const accounts = new Accounts([grok.fake], memoryUsageStorage(), clock().fake);
    expect(await accounts.signInCommand('grok-build')).toEqual({
      file: '/bin/grok-build',
      args: ['login'],
    });
    await accounts.readAgain('grok-build');
    expect(grok.asked).toEqual([true]);
    expect(accounts.list().accounts[0]?.signIn).toEqual({
      state: 'signed-in',
      method: 'subscription',
    });
  });

  it('spends a reset only once the user confirms, and reads the usage after it', async () => {
    const codex = source('codex', () => Promise.resolve(subscribed), true);
    const accounts = new Accounts(
      [codex.fake],
      memoryUsageStorage({ codex: { windows: [], resets: 3, readAt: 1 } }),
      clock().fake,
    );
    const confirmReset = vi.fn<AccountsUi['confirmReset']>(() => Promise.resolve(false));
    expect(await accounts.reset('codex', { confirmReset })).toBeNull();
    expect(confirmReset).toHaveBeenCalledWith('codex', 3);
    expect(codex.reset).not.toHaveBeenCalled();
    confirmReset.mockResolvedValue(true);
    expect(await accounts.reset('codex', { confirmReset })).toBe('reset');
    expect(codex.reset).toHaveBeenCalledOnce();
    expect(codex.asked).toEqual([true]);
    await expect(
      new Accounts(
        [source('claude-code', () => Promise.resolve(subscribed)).fake],
        memoryUsageStorage(),
        clock().fake,
      ).reset('claude-code', { confirmReset }),
    ).rejects.toThrow('no reset');
  });
});

describe('usageStorage', () => {
  let folder = '';
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('keeps each provider’s windows in accounts.json and leaves out an entry of another shape', () => {
    folder = mkdtempSync(join(tmpdir(), 'accounts-'));
    const storage = usageStorage(folder);
    const usage: KeptUsage = {
      codex: {
        windows: [fiveHour(10), { span: 600, model: 'Opus', used: null, resetsAt: null }],
        resets: 1,
        readAt: 7,
      },
    };
    storage.save(usage);
    expect(usageStorage(folder).load()).toEqual(usage);
    writeFileSync(
      join(folder, 'accounts.json'),
      JSON.stringify({
        usage: { codex: { windows: 'none' }, 'grok-build': { windows: [], readAt: 3 } },
      }),
    );
    expect(usageStorage(folder).load()).toEqual({ 'grok-build': { windows: [], readAt: 3 } });
  });
});

describe('Accounts and where the providers run from', () => {
  it('shows what runs for each provider, asks none that is not installed, and passes on a download as it goes', async () => {
    const claude = source('claude-code', () => Promise.resolve(subscribed));
    const codex = source('codex', () => Promise.resolve(subscribed));
    const claudeInstall = install('claude-code', {
      runs: { source: 'user', version: '2.1.340' },
      pinned: '2.1.330',
    });
    const codexInstall = install('codex', { runs: null, pinned: '0.171.0' });
    const accounts = new Accounts([claude.fake, codex.fake], memoryUsageStorage(), clock().fake, [
      claudeInstall.fake,
      codexInstall.fake,
    ]);
    await accounts.readAll();
    expect(claude.asked).toEqual([true]);
    expect(codex.asked).toEqual([]);
    const listed = accounts.list().accounts;
    expect(listed[0]?.install).toEqual({
      runs: { source: 'user', version: '2.1.340' },
      pinned: '2.1.330',
    });
    expect(listed[1]).toMatchObject({ signIn: { state: 'unknown' }, install: { runs: null } });
    const heard: (InstallView | undefined)[] = [];
    accounts.onChange((list) => heard.push(list.accounts[1]?.install));
    codexInstall.set({ runs: null, pinned: '0.171.0', downloading: { received: 5, total: 10 } });
    codexInstall.set({ runs: { source: 'app', version: '0.171.0' }, pinned: '0.171.0' });
    expect(heard).toEqual([
      { runs: null, pinned: '0.171.0', downloading: { received: 5, total: 10 } },
      { runs: { source: 'app', version: '0.171.0' }, pinned: '0.171.0' },
    ]);
    await accounts.readAgain('codex');
    expect(codex.asked).toEqual([true]);
  });

  it('reads anew where each provider runs from as the Accounts panel shows, and asks a provider installed since its last read', async () => {
    const claude = source('claude-code', () => Promise.resolve(subscribed));
    const claudeInstall = install('claude-code', { runs: null, pinned: '2.1.330' });
    const accounts = new Accounts([claude.fake], memoryUsageStorage(), clock().fake, [
      claudeInstall.fake,
    ]);
    // As the window opens, the provider is not installed, so it is not asked.
    await accounts.readAll();
    expect(accounts.list().accounts[0]?.install?.runs).toBeNull();
    expect(claude.asked).toEqual([]);
    // The user installs their CLI, which the panel shows once it opens, asking of its account at once
    // rather than five minutes after that read.
    const view = { runs: { source: 'user' as const, version: '2.1.340' }, pinned: '2.1.330' };
    claudeInstall.fake.view = () => Promise.resolve(view);
    accounts.setShown(1, true);
    await settle();
    await settle();
    expect(accounts.list().accounts[0]?.install).toEqual(view);
    expect(claude.asked).toEqual([true]);
    expect(accounts.list().accounts[0]?.signIn).toEqual(subscribed.signIn);
    accounts.close();
  });
});
