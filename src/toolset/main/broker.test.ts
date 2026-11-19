import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { MessageImage } from '../../sessions/shared/events';
import type {
  AutomationEvent,
  AutomationSnapshot,
  Envelope,
  Frame,
  PresentationNotice,
  ProviderToolLink,
  SetupRequirement,
  TargetRef,
} from '../../sessions/shared/automation';
import { foldAutomationEvent, liveAutomationState } from '../../sessions/shared/automation-state';
import { FakeAutomationBridge } from '../shared/automation-fake';
import { AutomationBroker, type BrokerAccess } from './broker';
import type { AutomationTool, ExecutionPlan, ExecutionResult } from './execution';

const targetSchema = z.object({
  id: z.string(),
  kind: z.enum(['browser-tab', 'application', 'window', 'system-dialog']),
  generation: z.number(),
});
const inputSchema = z.object({
  target: targetSchema.optional(),
  observation: z.string().optional(),
  path: z.string().optional(),
  value: z.number().optional(),
});
const result = (): ExecutionResult => ({ outcome: { status: 'verified', value: { done: true } } });
const iconFixture: MessageImage = {
  mediaType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoaGj4DwAFhAKAjM1mJgAAAABJRU5ErkJggg==',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const execute = vi.fn<AutomationTool['execute']>(() => Promise.resolve(result()));
function tool(
  name: string,
  patch: Partial<ExecutionPlan> = {},
  family: AutomationTool['family'] = 'browser',
): AutomationTool {
  return {
    name,
    family,
    description: 'Synthetic contract fixture.',
    inputSchema,
    availability: { tools: 'ready', images: 'supported' },
    plan(raw) {
      const args = inputSchema.parse(raw);
      return {
        operation:
          family === 'panel'
            ? null
            : family === 'computer'
              ? 'application-background'
              : 'browser-tab',
        effect: family === 'panel' ? 'present' : 'mutate',
        delivery: 'background',
        mayActivate: false,
        ...(args.target ? { target: args.target } : {}),
        ...(args.observation ? { observationId: args.observation } : {}),
        ...(args.path ? { files: [{ path: args.path, kind: 'write' as const }] } : {}),
        ...patch,
      };
    },
    execute,
  };
}
let root: string;
let broker: AutomationBroker;
let a: BrokerAccess;
let b: BrokerAccess;
let serial = 0;
const policy = { mode: 'auto' as const, sandbox: 'workspace-write' as const };

it.each([
  { actionId: undefined, reason: 'required' },
  { actionId: null, reason: 'invalid-type' },
  { actionId: 42, reason: 'invalid-type' },
  { actionId: { privateValue: 'must-not-be-returned' }, reason: 'invalid-type' },
  { actionId: '', reason: 'too-short' },
  { actionId: 'x'.repeat(129), reason: 'too-long' },
])('identifies an actionId that is $reason without dispatching or echoing it', async (input) => {
  const refused = await broker.dispatch(a, 'panel_present', {}, { actionId: input.actionId });
  expect(refused.outcome).toEqual({
    status: 'refused',
    code: 'invalid-request',
    dispatched: false,
    detail: { kind: 'argument', field: 'actionId', reason: input.reason },
  });
  expect(broker.record('a', refused.automation.callId)?.outcome).toEqual(refused.outcome);
  expect(execute).not.toHaveBeenCalled();
  const corrected = await broker.dispatch(a, 'panel_present', {}, { actionId: 'corrected' });
  expect(corrected.outcome.status).toBe('verified');
  expect(execute).toHaveBeenCalledTimes(1);
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'automation-contract-')));
  for (const name of ['a', 'b', 'temporary', 'outside']) mkdirSync(join(root, name));
  execute.mockReset().mockImplementation(() => Promise.resolve(result()));
  broker = new AutomationBroker([
    tool('change'),
    tool('observe', { effect: 'observe' }),
    tool('navigate', { effect: 'navigate' }),
    tool('coordinate', { requiresObservation: true }),
    tool('capture', { effect: 'observe', requiresImages: true }),
    tool('native_change', {}, 'computer'),
    tool('foreground', { operation: 'application-foreground', delivery: 'foreground' }, 'computer'),
    tool('activation', { mayActivate: true }, 'computer'),
    tool('unknown_destination', { destinationKnown: false }, 'computer'),
    tool('panel_present', {}, 'panel'),
  ]);
  await broker.bind('a', join(root, 'a'), policy, [join(root, 'temporary')]);
  await broker.bind('b', join(root, 'b'), policy);
  a = broker.openAccess('a');
  b = broker.openAccess('b');
  broker.beginTurn('a');
  broker.beginTurn('b');
});
afterEach(async () => {
  await broker.close();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
const tab = (owner = 'a', sharing: 'none' | 'app' | 'global' = 'none') =>
  broker.register(owner, {
    backend: 'fixture-browser',
    key: `tab-${String(++serial)}`,
    kind: 'browser-tab',
    mayActivate: false,
    summary: {
      name: 'Synthetic site',
      address: 'https://example.test/',
      sharing,
      browser: 'embedded',
      profile: { id: 'fixture', name: 'Synthetic profile' },
    },
  });

it('rolls settled request identities past the bound while pinning running and uncertain effects', async () => {
  await broker.dispatch(a, 'panel_present', {}, { actionId: 'old' });
  execute.mockResolvedValueOnce({
    outcome: { status: 'indeterminate', reason: 'backend-lost', exclusionHeld: false },
  });
  await broker.dispatch(a, 'panel_present', {}, { actionId: 'uncertain' });
  const gate = deferred<ExecutionResult>();
  execute.mockReturnValueOnce(gate.promise);
  const pending = broker.dispatch(a, 'panel_present', {}, { actionId: 'running' });
  await vi.waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(3);
  });
  for (let n = 0; n < 4100; n++)
    expect(
      (await broker.dispatch(a, 'panel_present', {}, { actionId: `bounded-${String(n)}` })).outcome
        .status,
    ).toBe('verified');
  const count = execute.mock.calls.length;
  expect(
    (await broker.dispatch(a, 'panel_present', {}, { actionId: 'uncertain' })).outcome,
  ).toMatchObject({ code: 'result-expired' });
  expect(
    (await broker.dispatch(a, 'panel_present', {}, { actionId: 'running' })).outcome.status,
  ).toBe('dispatched');
  expect(
    (await broker.dispatch(a, 'panel_present', {}, { actionId: 'bounded-4099' })).outcome.status,
  ).toBe('verified');
  expect(execute).toHaveBeenCalledTimes(count);
  // A confirmed, ancient ID is outside the rolling replay window; it no longer stops new work.
  expect((await broker.dispatch(a, 'panel_present', {}, { actionId: 'old' })).outcome.status).toBe(
    'verified',
  );
  expect(execute).toHaveBeenCalledTimes(count + 1);
  gate.resolve(result());
  await pending;
}, 20_000);

it('tracks provider availability and rejects result links from another owner, turn or access generation', async () => {
  expect(broker.snapshot('a').value.availability.tools).toBe('unknown');
  broker.providerAvailability(a, {
    tools: 'unavailable',
    images: 'unsupported',
    reason: { code: 'transport-unsupported', transport: 'streamable-http' },
  });
  expect(broker.snapshot('a').value.availability).toMatchObject({
    tools: 'unavailable',
    reason: { code: 'transport-unsupported' },
  });
  broker.discovered(a);
  expect(broker.snapshot('a').value.availability.tools).toBe('ready');
  const done = await broker.dispatch(a, 'panel_present', {}, { actionId: 'linked' });
  broker.providerResult(b, 'panel_present', 'foreign', done.automation);
  expect(broker.snapshot('a').value.recentCalls[0]?.providerEntry).toBeNull();
  const fresh = broker.openAccess('a');
  broker.providerAvailability(a, { tools: 'ready', images: 'supported' });
  expect(broker.snapshot('a').value.availability.tools).toBe('unknown');
  broker.providerResult(a, 'panel_present', 'old-access', done.automation);
  broker.providerResult(fresh, 'panel_present', 'new-access', done.automation);
  expect(broker.snapshot('a').value.recentCalls[0]?.providerEntry).toBeNull();
  const current = await broker.dispatch(fresh, 'panel_present', {}, { actionId: 'current' });
  broker.providerResult(fresh, 'other-tool', 'wrong-tool', current.automation);
  broker.providerResult(fresh, 'panel_present', 'native', current.automation);
  expect(broker.snapshot('a').value.recentCalls.at(-1)?.providerEntry).toMatchObject({
    providerToolId: 'native',
    accessGeneration: fresh.generation,
  });
  broker.endTurn('a');
  broker.beginTurn('a');
  broker.providerResult(fresh, 'panel_present', 'other-turn', current.automation);
  expect(broker.snapshot('a').value.recentCalls.at(-1)?.providerEntry).toMatchObject({
    providerToolId: 'native',
  });
});
const application = (owner: string, key: string) =>
  broker.register(owner, {
    backend: 'fixture-native',
    key,
    kind: 'application',
    mayActivate: true,
    summary: { name: 'Synthetic editor' },
  });
const call = (
  target: TargetRef | undefined,
  name = 'change',
  access = a,
  actionId = `action-${String(++serial)}`,
  more: Record<string, unknown> = {},
) => broker.dispatch(access, name, { ...(target ? { target } : {}), ...more }, { actionId });
async function approve(
  owner = 'a',
  decision: 'allow-once' | 'allow-for-session' | 'deny' = 'allow-once',
) {
  await vi.waitFor(() => {
    expect(broker.snapshot(owner).value.pendingApprovals).toHaveLength(1);
  });
  const id = required(broker.snapshot(owner).value.pendingApprovals[0]).id;
  expect(broker.answer(owner, id, { decision }).status).toBe('verified');
}

describe('trusted automation dispatch', () => {
  it('refuses forged callers and cross-owner/stale handles without work', async () => {
    const target = tab();
    await expect(call(target.ref, 'change', { generation: a.generation })).rejects.toThrow(
      'access-revoked',
    );
    expect((await call(target.ref, 'change', b)).outcome).toMatchObject({
      code: 'wrong-owner',
      dispatched: false,
    });
    expect((await call({ ...target.ref, generation: 0 })).outcome).toMatchObject({
      code: 'stale-target',
    });
    expect((await call({ ...target.ref, kind: 'application' })).outcome).toMatchObject({
      code: 'stale-target',
    });
    expect(execute).not.toHaveBeenCalled();
    const refused = required(broker.snapshot('b').value.recentCalls[0]);
    expect(refused.operationId).toBeNull();
    expect(broker.record('a', refused.callId)).toBeUndefined();
  });
  it('records pre-operation refusal and binds read-only even in yolo', async () => {
    const target = tab('a', 'global');
    broker.setPolicy('a', { mode: 'yolo', sandbox: 'read-only' });
    const refused = await call(target.ref);
    expect(refused.outcome).toMatchObject({ code: 'sandbox-denied' });
    expect(broker.record('a', refused.automation.callId)).toMatchObject({
      operationId: null,
      outcome: refused.outcome,
    });
    expect(broker.snapshot('a').value.pendingApprovals).toEqual([]);
    expect((await call(target.ref, 'navigate')).outcome.status).toBe('verified');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('discovers lazily and refuses unavailable setup or image input before operations', async () => {
    const target = tab();
    expect(broker.capabilities('a').tools).toHaveLength(10);
    expect(execute).not.toHaveBeenCalled();
    broker.availability('change', {
      tools: 'unavailable',
      images: 'unknown',
      reason: { code: 'extension-required', browser: 'chrome' },
    });
    const unavailable = await call(target.ref);
    expect(unavailable.outcome).toMatchObject({ code: 'setup-required' });
    expect(broker.record('a', unavailable.automation.callId)?.operationId).toBeNull();
    expect((await call(target.ref, 'capture')).outcome).toMatchObject({
      code: 'image-input-unsupported',
    });
    broker.imageInput('a', 'supported');
    expect((await call(target.ref, 'capture')).outcome.status).toBe('verified');
  });
  it('asks once per operation and retains session grants after Stop and turn end', async () => {
    const target = tab('a', 'app');
    const first = call(target.ref);
    await approve();
    await first;
    await call(target.ref);
    expect(broker.snapshot('a').value.grants).toHaveLength(1);
    broker.endOperation('a', required(broker.snapshot('a').value.operations[0]).id);
    const second = call(target.ref);
    await approve('a', 'allow-for-session');
    await second;
    broker.stop('a');
    broker.endTurn('a');
    broker.beginTurn('a');
    await call(target.ref);
    expect(broker.snapshot('a').value.pendingApprovals).toEqual([]);
    expect(broker.snapshot('a').value.grants.map((g) => g.scope)).toEqual(['session']);
    expect(broker.snapshot('a').value.endedGrants[0]?.grant.target.profile?.name).toBe(
      'Synthetic profile',
    );
  });
  it('keeps host approval answers owner-scoped and apart from provider IDs', async () => {
    const waiting = call(tab('a', 'global').ref);
    await vi.waitFor(() => {
      expect(broker.snapshot('a').value.pendingApprovals).toHaveLength(1);
    });
    const id = required(broker.snapshot('a').value.pendingApprovals[0]).id;
    expect(id.startsWith('host:')).toBe(true);
    expect(broker.answer('b', id, { decision: 'allow-for-session' }).status).toBe('refused');
    expect(broker.answer('a', 'provider-request', { decision: 'allow-once' }).status).toBe(
      'refused',
    );
    broker.answer('a', id, { decision: 'deny' });
    expect((await waiting).outcome).toMatchObject({ code: 'denied' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('retains ended target summaries without transferring a grant to a replacement', async () => {
    const target = tab('a', 'app');
    const first = call(target.ref);
    await approve('a', 'allow-for-session');
    await first;
    await broker.targetEnded('a', target.ref, 'tab-closed');
    expect(broker.snapshot('a').value.endedGrants.at(-1)).toMatchObject({
      reason: 'tab-closed',
      grant: { target: { name: 'Synthetic site', browser: 'embedded' } },
    });
    const second = call(tab('a', 'app').ref);
    await approve('a', 'deny');
    expect((await second).outcome.status).toBe('refused');
  });
  it('requires fresh operation authority after Hand Back and after ending a session grant', async () => {
    const target = tab('a', 'app');
    const first = call(target.ref);
    await approve();
    await first;
    broker.takeover('a', target.ref);
    expect((await call(target.ref)).outcome).toMatchObject({ code: 'target-paused' });
    broker.handBack('a', target.ref);
    const second = call(target.ref);
    await approve('a', 'allow-for-session');
    await second;
    const grant = required(broker.snapshot('a').value.grants[0]);
    expect(broker.endGrant('b', grant.id).status).toBe('refused');
    broker.endGrant('a', grant.id);
    const third = call(target.ref);
    await approve('a', 'deny');
    await third;
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('rotates access without losing resources or replaying a completed action', async () => {
    const target = tab();
    await call(target.ref, 'change', a, 'same-action');
    const next = broker.openAccess('a');
    await expect(call(target.ref, 'change', a)).rejects.toThrow('access-revoked');
    expect((await call(target.ref, 'change', next, 'same-action')).outcome.status).toBe('verified');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(broker.snapshot('a').value.resources[0]?.ref).toEqual(target.ref);
    expect(
      (await call(target.ref, 'change', next, 'same-action', { value: 2 })).outcome,
    ).toMatchObject({ code: 'request-conflict' });
  });
  it('invalidates observations on navigation, geometry change and backend restart', async () => {
    const target = tab();
    const observed = broker.observation('a', target.ref);
    broker.targetChanged('a', target.ref, 'document');
    expect(
      (await call(target.ref, 'coordinate', a, undefined, { observation: observed })).outcome,
    ).toMatchObject({ code: 'stale-observation' });
    const geometry = broker.observation('a', target.ref);
    broker.targetChanged('a', target.ref, 'geometry');
    expect(
      (await call(target.ref, 'coordinate', a, undefined, { observation: geometry })).outcome,
    ).toMatchObject({ code: 'stale-observation' });
    await broker.backendRestarted('fixture-browser');
    expect((await call(target.ref)).outcome).toMatchObject({ code: 'stale-target' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('checks existing and dangling symlinks and allows only owned temporary roots', async () => {
    const target = tab();
    symlinkSync(join(root, 'outside'), join(root, 'a', 'escape'));
    symlinkSync(join(root, 'outside', 'future'), join(root, 'a', 'dangling'));
    for (const path of [
      '../outside/file',
      'escape/file',
      'dangling',
      join(root, 'outside', 'file'),
    ])
      expect((await call(target.ref, 'change', a, undefined, { path })).outcome).toMatchObject({
        code: 'sandbox-denied',
      });
    expect(
      (
        await call(target.ref, 'change', a, undefined, {
          path: join(root, 'temporary', 'new', 'file'),
        })
      ).outcome.status,
    ).toBe('verified');
    expect(execute.mock.calls[0]?.[1].paths).toEqual([join(root, 'temporary', 'new', 'file')]);
    expect(
      (await call(application('a', 'editor').ref, 'unknown_destination')).outcome,
    ).toMatchObject({ code: 'file-scope-unverifiable' });
  });
});

describe('cancellation and scheduling', () => {
  it('cancels before dispatch and revokes work waiting for approval on policy changes', async () => {
    const target = tab('a', 'app');
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await broker.dispatch(
          a,
          'change',
          { target: target.ref },
          { actionId: 'cancelled', signal: controller.signal },
        )
      ).outcome.status,
    ).toBe('cancelled-before-dispatch');
    const waiting = call(target.ref);
    await vi.waitFor(() => {
      expect(broker.snapshot('a').value.pendingApprovals).toHaveLength(1);
    });
    broker.setPolicy('a', { mode: 'auto', sandbox: 'read-only' });
    expect((await waiting).outcome.status).toBe('cancelled-before-dispatch');
    expect(broker.snapshot('a').value.pendingApprovals).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it('holds the target lane after timeout until actual backend settlement, without replay', async () => {
    const target = tab();
    const slow = deferred<ExecutionResult>();
    execute.mockImplementationOnce(() => slow.promise);
    const first = broker.dispatch(
      a,
      'change',
      { target: target.ref },
      { actionId: 'slow', timeoutMs: 15 },
    );
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    const timedOut = await first;
    expect(timedOut.outcome).toEqual({
      status: 'indeterminate',
      reason: 'timeout',
      exclusionHeld: true,
    });
    const second = call(target.ref);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(execute).toHaveBeenCalledTimes(1);
    slow.resolve(result());
    await second;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(broker.record('a', timedOut.automation.callId)?.outcome).toMatchObject({
      exclusionHeld: false,
    });
    expect((await call(target.ref, 'change', a, 'slow')).outcome.status).toBe('indeterminate');
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('coordinates foreground and activation-prone background work across owners without blocking independent tabs', async () => {
    const appA = application('a', 'editor-a');
    const appB = application('b', 'editor-b');
    broker.setPolicy('a', { mode: 'yolo', sandbox: 'workspace-write' });
    broker.setPolicy('b', { mode: 'yolo', sandbox: 'workspace-write' });
    const slow = deferred<ExecutionResult>();
    execute.mockImplementationOnce(() => slow.promise);
    const first = call(appA.ref, 'foreground');
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    const queued = call(appB.ref, 'activation', b);
    await call(tab('b').ref, 'change', b);
    expect(execute).toHaveBeenCalledTimes(2);
    broker.stop('a');
    expect((await first).outcome.status).toBe('indeterminate');
    expect(execute).toHaveBeenCalledTimes(2);
    slow.resolve(result());
    await queued;
    expect(execute).toHaveBeenCalledTimes(3);
    expect(broker.snapshot('b').value.foregroundOwner).toBeNull();
  });
  it('rechecks stale geometry and revoked access after waits', async () => {
    const target = tab();
    const observation = broker.observation('a', target.ref);
    const slow = deferred<ExecutionResult>();
    execute.mockImplementationOnce(() => slow.promise);
    const first = call(target.ref);
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    const second = call(target.ref, 'coordinate', a, undefined, { observation });
    broker.targetChanged('a', target.ref, 'geometry');
    slow.resolve(result());
    await first;
    expect((await second).outcome).toMatchObject({ code: 'stale-observation' });
    expect(execute).toHaveBeenCalledTimes(1);
    const waiting = call(tab('a', 'app').ref);
    await vi.waitFor(() => {
      expect(broker.snapshot('a').value.pendingApprovals).toHaveLength(1);
    });
    broker.revoke(a);
    expect((await waiting).outcome.status).toBe('cancelled-before-dispatch');
  });
  it('uses the application lane across different native windows', async () => {
    broker.setPolicy('a', { mode: 'yolo', sandbox: 'workspace-write' });
    const app = application('a', 'editor');
    const window = (key: string) =>
      broker.register('a', {
        backend: 'fixture-native',
        key,
        kind: 'window',
        mayActivate: true,
        application: app.ref,
        summary: { name: key },
      });
    const slow = deferred<ExecutionResult>();
    execute.mockImplementationOnce(() => slow.promise);
    const first = call(window('one').ref, 'native_change');
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    const second = call(window('two').ref, 'native_change');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(execute).toHaveBeenCalledTimes(1);
    slow.resolve(result());
    await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('activity contracts', () => {
  it('keeps live-state events constant through history growth and folds record/grant evictions exactly', async () => {
    const target = tab('a', 'app');
    const initial = broker.snapshot('a');
    const expectedLive = JSON.stringify(liveAutomationState(initial.value));
    let live: Envelope<AutomationSnapshot> | null = initial;
    let latest = liveAutomationState(initial.value),
      recordEvictions = 0,
      grantEvictions = 0;
    const fake = new FakeAutomationBridge();
    fake.seed(initial.value, initial.epoch, initial.sequence);
    const unsubscribe = broker.subscribe('a', (event) => {
      if (live) live = foldAutomationEvent(live, event);
      fake.publish('a', event.value);
      if (event.value.kind === 'tool-call-removed') recordEvictions++;
      if (event.value.kind === 'grant-end-removed') grantEvictions++;
      if (event.value.kind === 'state') {
        latest = event.value.state;
        for (const approval of latest.pendingApprovals)
          broker.answer('a', approval.id, { decision: 'allow-once' });
      }
    });
    for (let index = 0; index < 257; index++) {
      const response = await call(target.ref);
      broker.endOperation(
        'a',
        required(broker.record('a', response.automation.callId)?.operationId),
      );
      if (index === 255) {
        expect(broker.snapshot('a').value.recentCalls).toHaveLength(256);
        expect(broker.snapshot('a').value.endedGrants).toHaveLength(256);
        expect(JSON.stringify(latest)).toBe(expectedLive);
      }
    }
    expect(recordEvictions).toBe(1);
    expect(grantEvictions).toBe(1);
    expect(JSON.stringify(latest)).toBe(expectedLive);
    expect(latest).not.toHaveProperty('recentCalls');
    expect(latest).not.toHaveProperty('endedGrants');
    expect(latest).not.toHaveProperty('presentationNotices');
    expect(live).toEqual(broker.snapshot('a'));
    expect(await fake.snapshot('a')).toEqual(broker.snapshot('a'));
    unsubscribe();
  });
  it('omits unusable icons without rejecting targets and authorizes shared icon bytes by retained facts', async () => {
    const register = (image: MessageImage, owner = 'a') =>
      broker.register(owner, {
        backend: 'fixture-browser',
        key: `icon-tab-${String(++serial)}`,
        kind: 'browser-tab',
        mayActivate: false,
        summary: { name: 'Synthetic icon target', sharing: 'app', icon: image },
      });
    for (const image of [
      { ...iconFixture, mediaType: 'image/jpeg' as const },
      { ...iconFixture, data: 'A'.repeat(90 * 1024) },
      { ...iconFixture, data: 'AAAA' },
    ]) {
      const registered = register(image);
      expect(registered.iconId).toBeUndefined();
      expect(registered.ref.id).toBeTruthy();
      await broker.targetEnded('a', registered.ref, 'tab-closed');
    }
    const targets = Array.from({ length: 20 }, () => register(iconFixture));
    const target = required(targets[0]),
      iconId = required(target.iconId);
    expect(new Set(targets.map((item) => item.iconId))).toEqual(new Set([iconId]));
    expect(broker.icon('b', iconId)).toMatchObject({ code: 'not-found' });
    const anotherOwner = register(iconFixture, 'b');
    expect(anotherOwner.iconId).toBe(iconId);
    const unsubscribe = broker.subscribe('a', (event) => {
      if (event.value.kind === 'state')
        for (const approval of event.value.state.pendingApprovals)
          broker.answer('a', approval.id, { decision: 'allow-once' });
    });
    const response = await call(target.ref);
    broker.endOperation('a', required(broker.record('a', response.automation.callId)?.operationId));
    const record = required(broker.record('a', response.automation.callId));
    expect(record.approval?.request.target.iconId).toBe(iconId);
    expect(record.grantEnd?.grant.target.iconId).toBe(iconId);
    for (const item of targets) await broker.targetEnded('a', item.ref, 'tab-closed');
    expect(broker.icon('a', iconId)).toEqual({ status: 'verified', value: iconFixture });
    expect(JSON.stringify(broker.snapshot('a'))).not.toContain(iconFixture.data);
    const fake = new FakeAutomationBridge();
    fake.seed(broker.snapshot('a').value);
    fake.seed(broker.snapshot('b').value);
    fake.seedIcon(iconId, iconFixture);
    expect(await fake.icon('a', iconId)).toEqual({ status: 'verified', value: iconFixture });
    const plain = tab('a', 'app');
    for (let index = 0; index < 257; index++) {
      const current = await call(plain.ref);
      broker.endOperation(
        'a',
        required(broker.record('a', current.automation.callId)?.operationId),
      );
    }
    expect(broker.icon('a', iconId)).toMatchObject({ code: 'not-found' });
    expect(broker.icon('b', iconId)).toEqual({ status: 'verified', value: iconFixture });
    fake.seed(broker.snapshot('a').value);
    expect(await fake.icon('a', iconId)).toMatchObject({ code: 'not-found' });
    unsubscribe();
  });
  const notice = (version = 1): PresentationNotice => ({
    noticeId: `notice-${String(version)}`,
    owner: 'a',
    reuseKey: 'result',
    presentation: {
      id: 'presentation',
      title: 'Synthetic result',
      version,
      items: [{ content: { kind: 'artifact', artifactId: 'artifact' }, box: null }],
    },
  });
  function link(callId: string): ProviderToolLink {
    const record = required(broker.record('a', callId));
    return {
      callId,
      sessionId: 'a',
      turnId: record.turnId,
      accessGeneration: record.accessGeneration,
      toolName: record.toolName,
      providerToolId: 'provider-tool',
    };
  }
  it('returns the per-call setup requirement without leaving a settled session waiting for setup', async () => {
    const requirement: SetupRequirement = {
      kind: 'site-access',
      browser: 'safari',
      profile: { id: 'fixture', name: 'Synthetic profile' },
      role: 'page-preview',
      origin: 'http://127.0.0.1',
    };
    const setup = new AutomationBroker([
      tool('setup_fixture', { effect: 'metadata', operation: null, setup: requirement }),
    ]);
    try {
      await setup.bind('fixture', join(root, 'a'), policy);
      setup.beginTurn('fixture');
      const response = await setup.dispatch(
        setup.openAccess('fixture'),
        'setup_fixture',
        {},
        { actionId: 'setup' },
      );
      expect(response.outcome).toEqual({
        status: 'refused',
        code: 'setup-required',
        dispatched: false,
        detail: { kind: 'setup', requirement },
      });
      setup.endTurn('fixture');
      expect(setup.snapshot('fixture').value.phase).toBe('idle');
      expect(setup.snapshot('fixture').value.recentCalls[0]?.outcome).toEqual(response.outcome);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await setup.close();
    }
  });
  it('keeps the precise panel refusal and current version in the model result and retained call', async () => {
    const detail = {
      kind: 'presentation',
      reason: 'presentation-changed',
      current: notice(3).presentation,
    } as const;
    execute.mockResolvedValueOnce({
      outcome: { status: 'refused', code: 'layout-conflict', dispatched: false, detail },
    });
    const response = await call(undefined, 'panel_present');
    expect(response.outcome).toMatchObject({ code: 'layout-conflict', detail });
    expect(broker.record('a', response.automation.callId)?.outcome).toEqual(response.outcome);
  });
  it('retains the bounded denial message and its answer in the call after a renderer reload', async () => {
    const pending = call(tab('a', 'app').ref);
    await vi.waitFor(() => {
      expect(broker.snapshot('a').value.pendingApprovals).toHaveLength(1);
    });
    const approval = required(broker.snapshot('a').value.pendingApprovals[0]);
    expect(
      broker.answer('a', approval.id, { decision: 'deny', message: 'x'.repeat(2049) }),
    ).toMatchObject({ code: 'limit-exceeded' });
    const answer = { decision: 'deny', message: 'Use the synthetic tab instead.' } as const;
    broker.answer('a', approval.id, answer);
    const response = await pending;
    expect(response.outcome).toEqual({
      status: 'refused',
      code: 'denied',
      dispatched: false,
      detail: { kind: 'denial', message: answer.message },
    });
    const reloaded = new FakeAutomationBridge();
    reloaded.seed(broker.snapshot('a').value);
    const restored = await reloaded.callRecord('a', response.automation.callId);
    expect(restored).toMatchObject({
      status: 'verified',
      value: {
        approval: {
          request: { id: approval.id, callId: response.automation.callId },
          answer,
        },
        operationEnd: { reason: 'denied' },
      },
    });
    if (restored.status !== 'verified') throw new Error('Missing retained call.');
    expect(restored.value.approval?.answeredAt).toBeTypeOf('number');
    expect(restored.value.operationEnd?.at).toBeTypeOf('number');
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps a session grant linked to the approval call and records both operation and grant endings', async () => {
    const pending = call(tab('a', 'app').ref);
    await approve('a', 'allow-for-session');
    const response = await pending;
    const grant = required(broker.snapshot('a').value.grants[0]);
    broker.endTurn('a');
    expect(broker.record('a', response.automation.callId)).toMatchObject({
      grantId: grant.id,
      grantEnd: null,
      approval: { answer: { decision: 'allow-for-session' }, grantId: grant.id },
      operationEnd: { reason: 'turn-ended' },
    });
    broker.endGrant('a', grant.id);
    expect(broker.snapshot('a').value.recentCalls[0]).toMatchObject({
      grantEnd: { grant: { id: grant.id }, reason: 'user-ended' },
    });
    expect(broker.snapshot('a').value.recentCalls[0]?.grantEnd?.endedAt).toBeTypeOf('number');
  });
  it('retains activation, dialog, secure-input and takeover facts with their call and time', async () => {
    execute.mockImplementationOnce((_args, context) => {
      expect(context.report({ kind: 'target-self-activated', cause: 'popup' }).status).toBe(
        'verified',
      );
      context.report({ kind: 'dialog-dismissed', dialog: 'confirm' });
      context.report({ kind: 'secure-input', enabled: true });
      return Promise.resolve(result());
    });
    const target = tab();
    const response = await call(target.ref);
    broker.takeover('a', target.ref);
    const record = required(broker.record('a', response.automation.callId));
    expect(record.incidents.map((event) => event.kind)).toEqual([
      'target-self-activated',
      'dialog-dismissed',
      'secure-input',
      'takeover',
    ]);
    for (const event of record.incidents) {
      expect(event.at).toEqual(expect.any(Number));
      expect(event.operationId).toBe(record.operationId);
    }
    expect(record.operationEnd?.reason).toBe('takeover');
    expect(
      broker.recordIncident('a', record.callId, {
        kind: 'secure-input',
        enabled: false,
        at: 1,
        operationId: 'other-operation',
      }),
    ).toMatchObject({ code: 'invalid-request' });
  });
  it('folds the broker stream into the same state a reload receives, including notice retirement', async () => {
    let live: Envelope<AutomationSnapshot> | null = broker.snapshot('a');
    const events: Envelope<AutomationEvent>[] = [];
    const unsubscribe = broker.subscribe('a', (event) => {
      events.push(event);
      if (live) live = foldAutomationEvent(live, event);
    });
    const target = tab('a', 'app');
    broker.recordPresentation('a', notice());
    const pending = call(target.ref);
    await approve('a', 'allow-for-session');
    await pending;
    broker.endTurn('a');
    broker.endGrant('a', required(broker.snapshot('a').value.grants[0]).id);
    const delivery = broker.prepareNotices('a');
    broker.noticesDelivered('a', delivery.id, true);
    expect(live).toEqual(broker.snapshot('a'));
    const fake = new FakeAutomationBridge();
    fake.seed(
      required(live).value,
      required(live).epoch,
      required(live).sequence,
      broker.capabilities('a'),
    );
    expect(await fake.capabilities('a')).toEqual(broker.capabilities('a'));
    const before = await fake.snapshot('a');
    let received: Envelope<AutomationSnapshot> | null = before;
    fake.subscribe('a', (event) => {
      received = foldAutomationEvent(before, event);
    });
    fake.skipSequence('a');
    fake.publish('a', { kind: 'presentation-notices', notices: [notice(2)] });
    expect(received).toBeNull();
    expect((await fake.snapshot('a')).value.presentationNotices).toEqual([notice(2)]);
    expect(events.length).toBeGreaterThan(0);
    unsubscribe();
  });
  it('records panel results and retires notices only on their validated provider result', async () => {
    execute.mockResolvedValueOnce({
      ...result(),
      presentations: [
        {
          id: 'presentation',
          title: 'Synthetic result',
          version: 1,
          items: [
            {
              content: { kind: 'artifact', artifactId: 'artifact' },
              box: { x: 0.5, y: 0, width: 0.5, height: 1 },
            },
          ],
        },
      ],
    });
    broker.recordPresentation('a', notice());
    const response = await call(undefined, 'panel_present');
    const id = response.automation.callId;
    expect(broker.record('a', id)).toMatchObject({
      family: 'panel',
      presentations: [{ id: 'presentation', version: 1 }],
    });
    expect(response.presentationNotices).toEqual([notice()]);
    broker.recordPresentation('a', notice(2));
    expect(broker.link({ ...link(id), accessGeneration: 0 }).status).toBe('refused');
    expect(broker.snapshot('a').value.presentationNotices).toEqual([notice(2)]);
    expect(broker.link(link(id)).status).toBe('verified');
    expect(broker.snapshot('a').value.presentationNotices).toEqual([notice(2)]);
    expect(broker.link(link(id)).status).toBe('verified');
    expect(broker.link({ ...link(id), providerToolId: 'another-entry' }).status).toBe('refused');
  });
  it('keeps notices on reads, failed sends and reconnect; acceptance retires only its batch', () => {
    broker.recordPresentation('a', notice());
    const sent = broker.prepareNotices('a');
    broker.noticesDelivered('a', sent.id, false);
    broker.disconnect('a');
    broker.openAccess('a');
    const retry = broker.prepareNotices('a');
    broker.recordPresentation('a', notice(2));
    broker.noticesDelivered('a', retry.id, true);
    expect(broker.snapshot('a').value.presentationNotices).toEqual([notice(2)]);
  });
  it('offers cloned snapshots and controllable UI fakes without backend work', async () => {
    const fake = new FakeAutomationBridge();
    fake.seed(broker.snapshot('a').value);
    const events = vi.fn();
    const unsubscribe = fake.subscribe('a', events);
    fake.outcome = { status: 'refused', code: 'not-found', dispatched: false };
    expect((await fake.endGrant('a', 'missing')).status).toBe('refused');
    fake.publish('a', {
      kind: 'state',
      state: { ...liveAutomationState(broker.snapshot('a').value), phase: 'paused' },
    });
    const snapshot = await fake.snapshot('a');
    snapshot.value.phase = 'idle';
    expect((await fake.snapshot('a')).value.phase).toBe('paused');
    unsubscribe();
    fake.publish('a', { kind: 'availability', value: { tools: 'unknown', images: 'unknown' } });
    expect(events).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing fixture value.');
  return value;
}

it('cancels the stopped owner’s queued mutation without cancelling another owner', async () => {
  const target = tab();
  const other = tab('b');
  const slow = deferred<ExecutionResult>();
  execute.mockImplementationOnce(() => slow.promise);
  const first = call(target.ref);
  await vi.waitFor(() => {
    expect(execute).toHaveBeenCalledTimes(1);
  });
  const queued = call(target.ref);
  broker.stop('a');
  expect((await queued).outcome.status).toBe('cancelled-before-dispatch');
  expect((await first).outcome.status).toBe('indeterminate');
  expect((await call(other.ref, 'change', b)).outcome.status).toBe('verified');
  slow.resolve(result());
  expect(execute).toHaveBeenCalledTimes(2);
});

it('ends isolated resources but only detaches shared resources when a session closes', async () => {
  const isolated = vi.fn(() => Promise.resolve());
  const shared = vi.fn(() => Promise.resolve());
  broker.register('a', {
    backend: 'fixture',
    key: 'isolated',
    kind: 'browser-tab',
    mayActivate: false,
    summary: { name: 'Isolated', sharing: 'none' },
    release: isolated,
  });
  broker.register('a', {
    backend: 'fixture',
    key: 'shared',
    kind: 'browser-tab',
    mayActivate: false,
    summary: { name: 'Shared', sharing: 'global' },
    release: shared,
  });
  broker.disconnect('a');
  expect(isolated).not.toHaveBeenCalled();
  expect(shared).not.toHaveBeenCalled();
  await broker.closeOwner('a');
  expect(isolated).toHaveBeenCalledWith('delete-isolated');
  expect(shared).toHaveBeenCalledWith('detach');
  expect(broker.active(a)).toBe(false);
  expect(broker.snapshot('b').value.policy).toEqual(policy);
});

it('retains partial effects and does not replay a mutation whose outcome became indeterminate', async () => {
  const target = tab();
  execute.mockResolvedValueOnce({
    outcome: { status: 'partial', completed: ['synthetic-step'], remaining: 'unknown' },
  });
  const partial = await call(target.ref, 'change', a, 'partial');
  expect(partial.outcome).toEqual({
    status: 'partial',
    completed: ['synthetic-step'],
    remaining: 'unknown',
  });
  expect((await call(target.ref, 'change', a, 'partial')).outcome).toEqual(partial.outcome);
  execute.mockRejectedValueOnce(new Error('Synthetic backend loss.'));
  const uncertain = await call(target.ref, 'change', a, 'uncertain');
  expect(uncertain.outcome.status).toBe('indeterminate');
  const next = broker.openAccess('a');
  expect((await call(target.ref, 'change', next, 'uncertain')).outcome.status).toBe(
    'indeterminate',
  );
  expect(execute).toHaveBeenCalledTimes(2);
});

it('retains real frame bytes with their call and rejects a frame for another receiver', async () => {
  const events: Envelope<AutomationEvent>[] = [];
  const unsubscribe = broker.subscribe('a', (event) => events.push(event));
  const target = tab();
  const frame: Frame = {
    target: target.ref,
    observationId: 'synthetic-frame',
    documentGeneration: 0,
    geometryGeneration: 0,
    capturedAt: 1,
    image: {
      mediaType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoaGj4DwAFhAKAjM1mJgAAAABJRU5ErkJggg==',
    },
    imageSize: { width: 1, height: 1 },
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    units: 'css-pixels',
    imageToViewport: [1, 0, 0, 1, 0, 0],
  };
  execute.mockResolvedValueOnce({ ...result(), frames: [frame] });
  const captured = await call(target.ref, 'observe', a, 'image');
  expect(captured.frames).toEqual([frame]);
  expect(broker.frames('a', captured.automation.callId)).toEqual({
    status: 'verified',
    value: [frame],
  });
  expect(broker.frames('b', captured.automation.callId)).toMatchObject({ code: 'not-found' });
  expect(JSON.stringify(events)).not.toContain(frame.image.data);
  expect(JSON.stringify(broker.snapshot('a'))).not.toContain(frame.image.data);
  const fake = new FakeAutomationBridge();
  fake.seed(broker.snapshot('a').value);
  fake.seedFrames('a', captured.automation.callId, [frame]);
  expect(await fake.callFrames('a', captured.automation.callId)).toEqual({
    status: 'verified',
    value: [frame],
  });
  await broker.targetEnded('a', target.ref, 'tab-closed');
  const replayed = await call(target.ref, 'observe', a, 'image');
  expect(replayed.frames).toEqual([frame]);
  expect(execute).toHaveBeenCalledTimes(1);
  const another = tab();
  execute.mockResolvedValueOnce({ ...result(), frames: [frame] });
  const wrong = await call(another.ref, 'observe');
  expect(wrong.outcome.status).toBe('indeterminate');
  expect(wrong.frames).toEqual([]);
  unsubscribe();
});

it('advertises and enforces the feature argument budget before dispatch', async () => {
  const fixture: AutomationTool = {
    ...tool('bounded', {}, 'panel'),
    inputSchema: z.object({ text: z.string() }),
    maxArgumentBytes: 64,
  };
  const bounded = new AutomationBroker([fixture]);
  try {
    await bounded.bind('bounded-owner', join(root, 'a'), policy);
    bounded.beginTurn('bounded-owner');
    const access = bounded.openAccess('bounded-owner');
    expect(bounded.capabilities('bounded-owner').tools[0]?.maxArgumentBytes).toBe(64);
    const refused = await bounded.dispatch(
      access,
      'bounded',
      { text: '汉'.repeat(30) },
      { actionId: 'too-large' },
    );
    expect(refused.outcome).toMatchObject({ code: 'limit-exceeded' });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await bounded.close();
  }
  expect(() => new AutomationBroker([{ ...fixture, maxArgumentBytes: 17 * 1024 * 1024 }])).toThrow(
    'limit',
  );
});

it('withdraws an approval when its last waiting invocation is cancelled', async () => {
  const target = tab('a', 'app');
  const controller = new AbortController();
  const waiting = broker.dispatch(
    a,
    'change',
    { target: target.ref },
    { actionId: 'withdrawn', signal: controller.signal },
  );
  await vi.waitFor(() => {
    expect(broker.snapshot('a').value.pendingApprovals).toHaveLength(1);
  });
  controller.abort();
  expect((await waiting).outcome.status).toBe('cancelled-before-dispatch');
  expect(broker.snapshot('a').value.pendingApprovals).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
});
