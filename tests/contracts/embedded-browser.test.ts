import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { embeddedBrowser } from '../../src/app/main/browser-automation';
import type { DialogKind, EmbeddedEngine, PageState } from '../../src/browser/main/page';
import type { BrowserTabRef } from '../../src/browser/shared/browser';
import type { Outcome } from '../../src/sessions/shared/automation';
import { AutomationBroker, type BrokerAccess } from '../../src/toolset/main/broker';

const refSchema = z.object({ id: z.uuid(), generation: z.int(), kind: z.literal('browser-tab') });
const snapshotSchema = z.object({ observationId: z.uuid(), text: z.string() });
const targetUrl = 'https://fixture.example/start?synthetic=hidden#detail';

function fixture(dialogOnNavigation?: DialogKind, chrome?: Parameters<typeof embeddedBrowser>[2]) {
  const sessions = new Set<string>();
  const auth = new Map<string, string>();
  const cleared: string[] = [];
  const loads: string[] = [];
  const scripts: string[] = [];
  const closed = vi.fn();
  const click = vi.fn((): Promise<Outcome<null>> =>
    Promise.resolve({ status: 'dispatched', evidence: 'not-verified' }),
  );
  const engine: EmbeddedEngine = {
    page(partition, events) {
      sessions.add(partition);
      const state: PageState = {
        address: null,
        title: 'Fixture',
        loading: false,
        error: null,
        canGoBack: false,
        canGoForward: false,
        signIn: 'unknown',
      };
      return Promise.resolve({
        navigate(command) {
          if (command.kind === 'navigate') {
            loads.push(command.url);
            state.address = command.url;
            events.change(state, 'document');
            if (dialogOnNavigation) events.dialog(dialogOnNavigation);
          }
          return Promise.resolve({ status: 'verified', value: null });
        },
        observe() {
          return Promise.resolve({
            width: 640,
            height: 480,
            text: auth.get(partition) ?? 'guest',
            truncated: false,
            elements: [
              { ref: 1, role: 'textbox', label: 'Name' },
              { ref: 2, role: 'button', label: 'Save\n  Draft' },
              { ref: 3, role: 'button', label: 'a'.repeat(120) },
            ],
          });
        },
        action(_marker, action) {
          if (action.kind === 'type') auth.set(partition, action.text);
          return action.kind === 'click'
            ? click()
            : Promise.resolve({ status: 'verified', value: null });
        },
        capture: () => Promise.resolve(null),
        runScript(script) {
          scripts.push(script);
          return Promise.resolve({
            status: 'verified',
            value: { kind: 'value', value: auth.get(partition) ?? 'guest' },
          });
        },
        close() {
          closed();
          return Promise.resolve();
        },
      });
    },
    clear(partition) {
      auth.delete(partition);
      cleared.push(partition);
      return Promise.resolve();
    },
  };
  const { browser, tools } = embeddedBrowser(engine, () => broker, chrome);
  const broker = new AutomationBroker(tools);
  let serial = 0;
  const call = (
    access: BrokerAccess,
    name: string,
    args: Record<string, unknown>,
    actionId = String(++serial),
  ) => broker.dispatch(access, 'browser_' + name, args, { actionId });
  const bind = async (id: string, sandbox: 'workspace-write' | 'read-only' = 'workspace-write') => {
    await broker.bind(id, process.cwd(), { mode: 'auto', sandbox });
    const access = broker.openAccess(id);
    broker.beginTurn(id);
    return access;
  };
  const open = async (access: BrokerAccess, sharing: 'none' | 'app'): Promise<BrowserTabRef> => {
    const { outcome } = await call(access, 'open', { sharing });
    expect(outcome.status).toBe('verified');
    return refSchema.parse(outcome.status === 'verified' ? outcome.value : null);
  };
  const observe = async (access: BrokerAccess, target: BrowserTabRef) => {
    const { outcome } = await call(access, 'snapshot', { target });
    expect(outcome.status).toBe('verified');
    return snapshotSchema.parse(outcome.status === 'verified' ? outcome.value : null);
  };
  const setSignIn = async (access: BrokerAccess, target: BrowserTabRef, text: string) => {
    const { observationId } = await observe(access, target);
    const result = await call(access, 'act', {
      target,
      observationId,
      action: { kind: 'type', element: 1, text },
    });
    expect(result.outcome.status).toBe('verified');
  };
  const allow = async (owner: string) => {
    let approval = broker.snapshot(owner).value.pendingApprovals[0];
    await vi.waitFor(() => {
      approval = broker.snapshot(owner).value.pendingApprovals[0];
      expect(approval).toBeDefined();
    });
    if (!approval) throw new Error('Fixture did not ask.');
    expect(approval.target.address).toBe('https://fixture.example/start');
    expect(broker.answer(owner, approval.id, { decision: 'allow-once' }).status).toBe('verified');
  };
  const end = async () => {
    await broker.close();
    await browser.close();
  };
  return {
    broker,
    browser,
    sessions,
    loads,
    scripts,
    cleared,
    closed,
    click,
    call,
    bind,
    open,
    observe,
    setSignIn,
    allow,
    end,
  };
}

it('opens an app profile only after a per-tab approval and reuses its sign-in across owners', async () => {
  const f = fixture();
  try {
    const a = await f.bind('a');
    const b = await f.bind('b');
    const first = await f.open(a, 'app');
    expect(f.sessions.size).toBe(0);
    const loading = f.call(a, 'navigate', { target: first, url: targetUrl });
    expect(f.loads).toEqual([]);
    await f.allow('a');
    expect((await loading).outcome.status).toBe('verified');
    await f.setSignIn(a, first, 'signed-in fixture');
    expect((await f.call(b, 'snapshot', { target: first })).outcome).toMatchObject({
      code: 'wrong-owner',
    });
    const second = await f.open(b, 'app');
    const secondLoad = f.call(b, 'navigate', { target: second, url: targetUrl });
    await f.allow('b');
    expect((await secondLoad).outcome.status).toBe('verified');
    expect(await f.observe(b, second)).toMatchObject({ text: 'signed-in fixture' });
    expect(f.sessions.size).toBe(1);
    expect((await f.browser.clearAppSignIns()).status).toBe('verified');
    expect(await f.browser.snapshot('b', second)).toBeNull();
    expect(f.closed).toHaveBeenCalledTimes(2);
    const third = await f.open(b, 'app');
    const thirdLoad = f.call(b, 'navigate', { target: third, url: targetUrl });
    await f.allow('b');
    await thirdLoad;
    expect(await f.observe(b, third)).toMatchObject({ text: 'guest' });
  } finally {
    await f.end();
  }
});

it('reports a dismissed page dialog to the model and the same call record', async () => {
  const f = fixture('confirm');
  try {
    const access = await f.bind('a');
    const target = await f.open(access, 'none');
    const response = await f.call(access, 'navigate', { target, url: targetUrl });
    expect(response.outcome.status).toBe('verified');
    expect(response.dialogDismissals).toEqual(['confirm']);
    expect(f.broker.record('a', response.automation.callId)?.incidents).toEqual([
      expect.objectContaining({ kind: 'dialog-dismissed', dialog: 'confirm', target }),
    ]);
  } finally {
    await f.end();
  }
});

it('keeps bounded action and observed control facts in the owned record, including on replay', async () => {
  const f = fixture();
  try {
    const access = await f.bind('a');
    const target = await f.open(access, 'none');
    await f.call(access, 'navigate', { target, url: targetUrl });
    const dispatch = async (action: Record<string, unknown>) => {
      const { observationId } = await f.observe(access, target);
      return f.call(access, 'act', { target, observationId, action });
    };
    const { observationId } = await f.observe(access, target);
    const click = { target, observationId, action: { kind: 'click', element: 2 } };
    for (const result of [
      await f.call(access, 'act', click, 'click-once'),
      await f.call(access, 'act', click, 'click-once'),
    ]) {
      expect(result.outcome.status).toBe('dispatched');
      expect(result).not.toHaveProperty('browserAction');
      expect(f.broker.record('a', result.automation.callId)).toMatchObject({
        browserAction: { kind: 'click', label: 'Save Draft' },
      });
    }
    const stale = await f.call(access, 'act', click);
    expect(stale.outcome).toMatchObject({ code: 'stale-observation' });
    expect(f.broker.record('a', stale.automation.callId)).toHaveProperty('browserAction', {
      kind: 'click',
    });
    const typed = await dispatch({ kind: 'type', element: 1, text: 'fixture text to omit' });
    const record = f.broker.record('a', typed.automation.callId);
    expect(record).toMatchObject({ browserAction: { kind: 'type', label: 'Name' } });
    expect(JSON.stringify(record)).not.toContain('fixture text to omit');
    const long = await dispatch({ kind: 'click', element: 3 });
    expect(f.broker.record('a', long.automation.callId)).toMatchObject({
      browserAction: { kind: 'click', label: 'a'.repeat(100) },
    });
    const scroll = await dispatch({ kind: 'scroll', deltaY: 30 });
    expect(f.broker.record('a', scroll.automation.callId)).toMatchObject({
      browserAction: { kind: 'scroll' },
    });
  } finally {
    await f.end();
  }
});

it('retains a checked browser control label when stopped and withholds it from foreign calls', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<Outcome<null>>();
  try {
    const a = await f.bind('a');
    const b = await f.bind('b');
    const target = await f.open(a, 'none');
    await f.call(a, 'navigate', { target, url: targetUrl });
    const { observationId } = await f.observe(a, target);
    const input = { target, observationId, action: { kind: 'click', element: 2 } };
    const wrongOwner = await f.call(b, 'act', input);
    expect(wrongOwner.outcome).toMatchObject({ code: 'wrong-owner' });
    expect(f.broker.record('b', wrongOwner.automation.callId)).toMatchObject({
      target: { state: 'unresolved' },
      browserAction: { kind: 'click' },
    });
    expect(f.broker.record('b', wrongOwner.automation.callId)).not.toHaveProperty(
      'browserAction.label',
    );
    const missingId = await f.broker.dispatch(a, 'browser_act', input, {});
    expect(missingId.outcome).toMatchObject({ code: 'invalid-request' });
    expect(f.broker.record('a', missingId.automation.callId)).toMatchObject({
      browserAction: { kind: 'click', label: 'Save Draft' },
    });
    f.click.mockImplementationOnce(() => pending.promise);
    const running = f.call(a, 'act', input, 'stop-click');
    await vi.waitFor(() => {
      expect(f.click).toHaveBeenCalledTimes(1);
    });
    f.broker.stop('a');
    for (const result of [await running, await f.call(a, 'act', input, 'stop-click')]) {
      expect(result.outcome).toMatchObject({
        status: 'indeterminate',
        reason: 'cancelled-after-dispatch',
      });
      expect(f.broker.record('a', result.automation.callId)).toMatchObject({
        browserAction: { kind: 'click', label: 'Save Draft' },
      });
    }
    expect(f.click).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve({ status: 'dispatched', evidence: 'not-verified' });
    await f.end();
  }
});

it('keeps none sharing within one owner across turns, rejects stale references, and clears it on close', async () => {
  const f = fixture();
  try {
    const a = await f.bind('a');
    const b = await f.bind('b');
    const first = await f.open(a, 'none');
    await f.call(a, 'navigate', { target: first, url: targetUrl });
    await f.setSignIn(a, first, 'a only');
    const second = await f.open(b, 'none');
    await f.call(b, 'navigate', { target: second, url: targetUrl });
    expect(await f.observe(b, second)).toMatchObject({ text: 'guest' });
    f.broker.endTurn('a');
    f.broker.beginTurn('a');
    const seen = await f.observe(a, first);
    expect(seen.text).toBe('a only');
    await f.call(a, 'navigate', { target: first, url: targetUrl });
    expect(
      (
        await f.call(a, 'act', {
          target: first,
          observationId: seen.observationId,
          action: { kind: 'type', element: 1, text: 'stale' },
        })
      ).outcome,
    ).toMatchObject({ code: 'stale-observation' });
    expect(f.sessions.size).toBe(2);
    expect(f.broker.snapshot('a').value.pendingApprovals).toEqual([]);
    await f.broker.closeOwner('a');
    await f.browser.closeOwner('a');
    expect(f.cleared).toHaveLength(1);
    expect(await f.browser.snapshot('a', first)).toBeNull();
    expect(await f.observe(b, second)).toMatchObject({ text: 'guest' });
  } finally {
    await f.end();
  }
});

it('allows read-only navigation but rejects mutations, other schemes and global requests', async () => {
  const f = fixture();
  try {
    const a = await f.bind('a', 'read-only');
    const tab = await f.open(a, 'none');
    for (const url of [
      'file:///synthetic.txt',
      'https://username:password@fixture.example/',
      'mailto:test@example.org',
    ]) {
      expect((await f.call(a, 'navigate', { target: tab, url })).outcome).toMatchObject({
        code: 'invalid-request',
      });
    }
    expect(f.loads).toEqual([]);
    expect((await f.call(a, 'open', { sharing: 'global' })).outcome).toMatchObject({
      code: 'background-unavailable',
    });
    expect((await f.call(a, 'navigate', { target: tab, url: targetUrl })).outcome.status).toBe(
      'verified',
    );
    const { observationId } = await f.observe(a, tab);
    const input = { target: tab, observationId, action: { kind: 'click', element: 2 } };
    const refused = await f.call(a, 'act', input, 'sandbox-click');
    f.broker.setPolicy('a', { mode: 'auto', sandbox: 'workspace-write' });
    const replay = await f.call(a, 'act', input, 'sandbox-click');
    for (const result of [refused, replay]) {
      expect(result.outcome).toMatchObject({
        code: 'sandbox-denied',
        detail: { kind: 'sandbox', level: 'read-only' },
      });
      expect(f.broker.record('a', result.automation.callId)).toMatchObject({
        outcome: result.outcome,
        browserAction: { kind: 'click', label: 'Save Draft' },
      });
    }
    expect(f.click).not.toHaveBeenCalled();
    expect(await f.browser.command('a', tab, { kind: 'take-control' })).toMatchObject({
      status: 'verified',
    });
    expect((await f.call(a, 'snapshot', { target: tab })).outcome).toMatchObject({
      code: 'target-paused',
    });
    expect((await f.call(a, 'close', { target: tab })).outcome).toMatchObject({
      code: 'target-paused',
    });
    expect(await f.browser.command('a', tab, { kind: 'hand-back' })).toMatchObject({
      status: 'verified',
    });
    expect(await f.observe(a, tab)).toMatchObject({ text: 'guest' });
  } finally {
    await f.end();
  }
});

it('runs a script in a tab it owns within the tab’s operation, refuses it at read-only and makes the last observation stale', async () => {
  const f = fixture();
  try {
    const a = await f.bind('a');
    // A tab with no sharing never asks.
    const isolated = await f.open(a, 'none');
    await f.call(a, 'navigate', { target: isolated, url: targetUrl });
    const { observationId } = await f.observe(a, isolated);
    const ran = await f.call(a, 'evaluate', { target: isolated, script: 'document.title' });
    expect(ran.outcome).toEqual({ status: 'verified', value: { kind: 'value', value: 'guest' } });
    expect(f.broker.record('a', ran.automation.callId)).toMatchObject({
      toolName: 'browser_evaluate',
      browserAction: { kind: 'script', script: 'document.title' },
    });
    const click = { target: isolated, observationId, action: { kind: 'click', element: 2 } };
    expect((await f.call(a, 'act', click)).outcome).toMatchObject({ code: 'stale-observation' });
    expect(f.click).not.toHaveBeenCalled();
    // A tab with shared sign-ins asks once for its operation, and a script inside it asks nothing more.
    const shared = await f.open(a, 'app');
    const loading = f.call(a, 'navigate', { target: shared, url: targetUrl });
    await f.allow('a');
    await loading;
    expect((await f.call(a, 'evaluate', { target: shared, script: '1 + 1' })).outcome.status).toBe(
      'verified',
    );
    expect(f.broker.snapshot('a').value.pendingApprovals).toEqual([]);
    // Read-only refuses scripts, and a script beyond 32 KiB is not a valid request.
    f.broker.setPolicy('a', { mode: 'auto', sandbox: 'read-only' });
    expect(
      (await f.call(a, 'evaluate', { target: isolated, script: 'location.href' })).outcome,
    ).toMatchObject({ code: 'sandbox-denied' });
    f.broker.setPolicy('a', { mode: 'auto', sandbox: 'workspace-write' });
    const long = 'x'.repeat(32 * 1024 + 1);
    expect((await f.call(a, 'evaluate', { target: isolated, script: long })).outcome).toMatchObject(
      { code: 'invalid-request' },
    );
    expect(f.scripts).toEqual(['document.title', '1 + 1']);
  } finally {
    await f.end();
  }
});

it('closes a tab at the user’s Close, ending the agent’s use of it, also while the user has it', async () => {
  const f = fixture();
  try {
    const a = await f.bind('a');
    const kept = await f.open(a, 'none');
    const tab = await f.open(a, 'app');
    const loading = f.call(a, 'navigate', { target: tab, url: targetUrl });
    await f.allow('a');
    await loading;
    expect(await f.browser.command('a', tab, { kind: 'take-control' })).toMatchObject({
      status: 'verified',
    });
    expect(await f.browser.command('b', tab, { kind: 'close' })).toMatchObject({
      code: 'stale-target',
    });
    expect(await f.browser.command('a', tab, { kind: 'close' })).toEqual({
      status: 'verified',
      value: null,
    });
    expect(await f.browser.snapshot('a', tab)).toBeNull();
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.broker.snapshot('a').value.resources.map(({ ref }) => ref.id)).toEqual([kept.id]);
    expect(f.broker.snapshot('a').value.operations).toEqual([]);
    expect((await f.call(a, 'snapshot', { target: tab })).outcome).toMatchObject({
      status: 'refused',
    });
  } finally {
    await f.end();
  }
});
