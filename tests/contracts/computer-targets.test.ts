import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { computerAutomation } from '../../src/app/main/computer-automation';
import { NativeHelper } from '../../src/computer/main/helper';
import type { ControlSurface } from '../../src/computer/main/computer';
import { NATIVE_WIRE_VERSION, type NativeEvent } from '../../src/computer/main/native-protocol';
import type { AutomationPolicy, Outcome } from '../../src/sessions/shared/automation';
import { AutomationBroker } from '../../src/toolset/main/broker';

const target = z.object({
  id: z.uuid(),
  kind: z.enum(['application', 'window']),
  generation: z.int().positive(),
});
const observation = z.object({ observationId: z.uuid() });
const inventory = z.object({
  applications: z.array(z.strictObject({ id: z.uuid(), name: z.string(), bundleId: z.string() })),
});
const windowList = z.object({ windows: z.array(z.object({ target })) });
const request = z.looseObject({
  id: z.int(),
  generation: z.uuid(),
  version: z.int(),
  kind: z.enum([
    'hello',
    'permissions',
    'applications',
    'application',
    'windows',
    'observe',
    'preview',
    'action',
    'cancel',
  ]),
});
type Request = z.infer<typeof request>;
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X8B8sAAAAASUVORK5CYII=';

function value<T>(schema: z.ZodType<T>, outcome: Outcome): T {
  if (outcome.status !== 'verified')
    throw Error(`Fixture call did not succeed (${outcome.status}).`);
  return schema.parse(outcome.value);
}

function fixture(twoApplications = false, surface?: ControlSurface) {
  const input = new PassThrough();
  const output = new PassThrough();
  let ended!: () => void;
  let holdExit = false;
  const exit = new Promise<void>((done) => {
    ended = done;
  });
  const launch = vi.fn(() =>
    Promise.resolve({
      pid: 98,
      input,
      output,
      exit,
      stop: () => {
        if (!holdExit) ended();
        return exit;
      },
    }),
  );
  const app = {
    pid: 101,
    startedAt: 200,
    processStart: '201',
    bundleId: 'test.fixture',
    name: 'Fixture',
  };
  const otherApp = {
    ...app,
    pid: 102,
    processStart: '202',
    bundleId: 'test.other',
    name: 'Other fixture',
  };
  const window = randomUUID();
  const otherWindow = randomUUID();
  const box = { x: -300, y: 24, width: 320, height: 180 };
  const requests: Request[] = [];
  let action: Request | undefined;
  let hold = false;
  let stale = false;
  let geometryPending = false;
  let missingAX = false;
  const emit = (call: Request, data: object) => {
    output.write(
      JSON.stringify({
        kind: call.kind,
        version: NATIVE_WIRE_VERSION,
        generation: call.generation,
        id: call.id,
        ...data,
      }) + '\n',
    );
  };
  const verified = (call: Request, value: unknown) => {
    emit(call, { result: { status: 'verified', value } });
  };
  const refused = (call: Request, code: string, permission?: string) => {
    emit(call, { result: { status: 'refused', code, permission } });
  };
  input.on('data', (bytes: Buffer) => {
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    const call = request.parse(raw);
    requests.push(call);
    switch (call.kind) {
      case 'hello':
        emit(call, { pid: 98 });
        break;
      case 'permissions':
        emit(call, {
          permissions: { accessibility: true, screenRecording: true, inputMonitoring: false },
        });
        break;
      case 'applications':
        emit(call, {
          inventory: { applications: twoApplications ? [app, otherApp] : [app], truncated: false },
        });
        break;
      case 'application':
        verified(call, null);
        break;
      case 'windows': {
        const { pid } = z.object({ pid: z.int() }).parse(call.application);
        if (missingAX) refused(call, 'setup-required', 'accessibility');
        else
          verified(call, {
            windows: [
              {
                id: pid === otherApp.pid ? otherWindow : window,
                title: 'Fixture window',
                bounds: box,
                minimized: false,
              },
            ],
            truncated: false,
          });
        break;
      }
      case 'observe':
        if (stale) refused(call, 'stale-target');
        else if (geometryPending) {
          geometryPending = false;
          refused(call, 'stale-observation');
        } else
          verified(call, {
            id: randomUUID(),
            bounds: box,
            truncated: false,
            elements: [
              { id: 1, role: 'AXTextField', label: 'Fixture field', actions: ['type'] },
              { id: 2, role: 'AXButton', label: 'Save Draft', actions: ['click'] },
            ],
            ...(call.image === true
              ? {
                  image: {
                    mediaType: 'image/png',
                    data: png,
                    width: 640,
                    height: 360,
                    capturedAt: 301,
                  },
                }
              : {}),
          });
        break;
      case 'action':
        if (hold) action = call;
        else verified(call, null);
        break;
      case 'preview':
        verified(call, {
          frame: {
            id: randomUUID(),
            bounds: box,
            image: { mediaType: 'image/png', data: png, width: 640, height: 360, capturedAt: 302 },
          },
        });
        break;
      case 'cancel':
        break;
    }
  });
  const helper = new NativeHelper(launch, (generation) => {
    native.computer.generationEnded(generation);
  });
  const native = computerAutomation(helper, () => broker, surface);
  const broker = new AutomationBroker(native.tools);
  let serial = 0;
  async function owner(id: string, policy: AutomationPolicy) {
    await broker.bind(id, process.cwd(), policy);
    const access = broker.openAccess(id);
    broker.beginTurn(id);
    const call = (name: string, args: object, actionId = String(++serial)) =>
      broker.dispatch(access, `computer_${name}`, args, { actionId });
    const discover = async (index = 0) =>
      value(inventory, (await call('targets', {})).outcome).applications[index];
    const select = async (index = 0) =>
      value(target, (await call('select', { id: (await discover(index))?.id })).outcome);
    const windows = async (application: z.infer<typeof target>) =>
      value(windowList, (await call('windows', { application })).outcome).windows[0]?.target;
    const observe = async (target: unknown) =>
      value(observation, (await call('observe', { target })).outcome).observationId;
    return { id, call, discover, select, windows, observe };
  }
  const allow = async (owner: string) => {
    await vi.waitFor(() => {
      expect(broker.snapshot(owner).value.pendingApprovals).toHaveLength(1);
    });
    const approval = broker.snapshot(owner).value.pendingApprovals[0];
    if (!approval) throw Error('Expected a pending approval.');
    expect(approval.target.ref.kind).toBe('application');
    expect(broker.answer(owner, approval.id, { decision: 'allow-once' }).status).toBe('verified');
  };
  return {
    owner,
    allow,
    launch,
    broker,
    computer: native.computer,
    requests,
    count: (kind: Request['kind']) => requests.filter((r) => r.kind === kind).length,
    move() {
      box.x += 5;
    },
    moving() {
      geometryPending = true;
    },
    hold() {
      hold = true;
    },
    stale() {
      stale = true;
    },
    withoutAX() {
      missingAX = true;
    },
    event(event: NativeEvent) {
      if (!action) throw Error('Fixture action has not dispatched.');
      emit(action, { kind: 'event', event });
    },
    settle(applied = false) {
      if (!action) throw Error('Fixture action has not dispatched.');
      if (applied) verified(action, null);
      else
        emit(action, { result: { status: 'indeterminate', reason: 'cancelled-after-dispatch' } });
      hold = false;
      action = undefined;
    },
    loseConnection() {
      holdExit = true;
      output.destroy(new Error('Synthetic helper pipe failure.'));
    },
    reap() {
      holdExit = false;
      ended();
    },
    async close() {
      if (holdExit) ended();
      await broker.close();
      await helper.close();
    },
  };
}

it('discovers metadata without a resource and uses one per-app grant for selected windows and frames', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'auto', sandbox: 'read-only' });
    const b = await f.owner('b', { mode: 'auto', sandbox: 'read-only' });
    expect(f.launch).not.toHaveBeenCalled();
    const discovered = await a.discover();
    expect(discovered).toEqual({
      id: discovered?.id,
      name: 'Fixture',
      bundleId: 'test.fixture',
    });
    expect(f.broker.snapshot(a.id).value).toMatchObject({
      pendingApprovals: [],
      grants: [],
      operations: [],
      resources: [],
    });
    expect((await b.call('select', { id: discovered?.id })).outcome).toMatchObject({
      code: 'stale-target',
    });
    expect((await a.call('select', { pid: 101 })).outcome).toMatchObject({
      code: 'invalid-request',
    });
    const application = value(target, (await a.call('select', { id: discovered?.id })).outcome);
    const listing = a.windows(application);
    await f.allow(a.id);
    const window = await listing;
    expect(window?.kind).toBe('window');
    expect((await b.call('observe', { target: window })).outcome).toMatchObject({
      code: 'wrong-owner',
    });
    expect((await a.call('observe', { target: window, image: true })).outcome).toMatchObject({
      code: 'image-input-unsupported',
    });
    f.broker.imageInput(a.id, 'supported');
    const result = await a.call('observe', { target: window, image: true });
    const { observationId } = value(observation, result.outcome);
    expect(f.broker.frames(a.id, result.automation.callId)).toMatchObject({
      status: 'verified',
      value: [
        {
          observationId,
          units: 'window-points',
          geometryGeneration: 0,
          viewport: { x: 0, y: 0, width: 320, height: 180 },
          imageToViewport: [0.5, 0, 0, 0.5, 0, 0],
          capturedAt: 301,
        },
      ],
    });
    const refused = await a.call('act', {
      target: window,
      observationId,
      action: { kind: 'click', element: 2 },
    });
    expect(refused.outcome).toMatchObject({
      code: 'sandbox-denied',
      detail: { kind: 'sandbox', level: 'read-only' },
    });
    expect(f.broker.record(a.id, refused.automation.callId)).toMatchObject({
      computerAction: { kind: 'click', label: 'Save Draft' },
      target: {
        state: 'resolved',
        summary: { name: 'Fixture window', applicationName: 'Fixture' },
      },
    });
    const foreign = await b.call('act', {
      target: window,
      observationId,
      action: { kind: 'click', element: 2 },
    });
    expect(f.broker.record(b.id, foreign.automation.callId)).toHaveProperty('computerAction', {
      kind: 'click',
    });
    expect(f.broker.record(b.id, foreign.automation.callId)).toMatchObject({
      target: { state: 'unresolved' },
    });
    expect(f.count('action')).toBe(0);
    expect((await a.call('release', { application })).outcome.status).toBe('verified');
    expect(f.broker.snapshot(a.id).value).toMatchObject({ operations: [], grants: [] });
    expect(f.broker.resource(a.id, application.id)?.ref).toEqual(application);
  } finally {
    await f.close();
  }
});

it('refuses unverifiable file triggers and invalidates observations when geometry or an action changes', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'workspace-write' });
    const application = await a.select();
    const window = await a.windows(application);
    const old = await a.observe(window);
    const type = (observationId: string) =>
      a.call('act', {
        target: window,
        observationId,
        action: { kind: 'type', element: 1, text: 'fixture private value' },
      });
    expect(
      (
        await a.call('act', {
          target: window,
          observationId: old,
          action: { kind: 'click', element: 1 },
        })
      ).outcome,
    ).toMatchObject({ code: 'file-scope-unverifiable' });
    f.move();
    expect(await a.windows(application)).toEqual(window);
    const stale = await type(old);
    expect(stale.outcome).toMatchObject({ code: 'stale-observation' });
    expect(f.broker.record(a.id, stale.automation.callId)).toHaveProperty('computerAction', {
      kind: 'type',
    });
    expect(f.count('action')).toBe(0);
    const fresh = await a.observe(window);
    const typed = await type(fresh);
    expect(typed.outcome.status).toBe('verified');
    const record = f.broker.record(a.id, typed.automation.callId);
    expect(record).toHaveProperty('computerAction', { kind: 'type', label: 'Fixture field' });
    expect(JSON.stringify(record)).not.toContain('fixture private value');
    expect(typed).not.toHaveProperty('computerAction');
    expect((await type(fresh)).outcome).toMatchObject({ code: 'stale-observation' });
    expect(f.count('action')).toBe(1);
    f.stale();
    expect((await a.call('observe', { target: window })).outcome).toMatchObject({
      code: 'stale-target',
    });
    expect(f.broker.snapshot(a.id).value.resources.map((r) => r.ref)).toEqual([application]);
  } finally {
    await f.close();
  }
});

it('discards an observation during a window move and keeps the same target for its next observation', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'full-access' });
    const application = await a.select();
    const window = await a.windows(application);
    if (!window) throw Error('Expected the fixture window.');
    const before = await a.observe(window);
    f.moving();
    expect((await a.call('observe', { target: window })).outcome).toMatchObject({
      code: 'stale-observation',
    });
    expect(f.broker.resource(a.id, window.id)?.ref).toEqual(window);
    expect(
      (
        await a.call('act', {
          target: window,
          observationId: before,
          action: { kind: 'click', element: 2 },
        })
      ).outcome,
    ).toMatchObject({ code: 'stale-observation' });
    expect(f.count('action')).toBe(0);
    f.move();
    expect(await a.observe(window)).not.toEqual(before);
  } finally {
    await f.close();
  }
});

it('reports native permission requirements through the setup result', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'workspace-write' });
    const application = await a.select();
    f.withoutAX();
    expect((await a.call('windows', { application })).outcome).toMatchObject({
      status: 'refused',
      code: 'setup-required',
      detail: { kind: 'setup', requirement: { kind: 'permission', permission: 'accessibility' } },
    });
  } finally {
    await f.close();
  }
});

it('rate-limits an owned preview and leaves the current action observation available', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'full-access' });
    const window = await a.windows(await a.select());
    if (!window) throw Error('Expected the fixture window.');
    const observationId = await a.observe(window);
    expect(await f.computer.preview('another', window.id)).toMatchObject({
      status: 'verified',
      value: { status: 'unavailable' },
    });
    expect(f.count('preview')).toBe(0);
    expect(await f.computer.preview(a.id, window.id)).toMatchObject({
      status: 'verified',
      value: { status: 'frame', frame: { target: window, capturedAt: 302 } },
    });
    expect(await f.computer.preview(a.id, window.id)).toMatchObject({ code: 'busy' });
    expect(f.count('preview')).toBe(1);
    expect(
      (
        await a.call('act', {
          target: window,
          observationId,
          action: { kind: 'type', element: 1, text: 'fixture preview test' },
        })
      ).outcome.status,
    ).toBe('verified');
  } finally {
    await f.close();
  }
});

it('leaves foreground activation to the user even in yolo', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'full-access' });
    const application = await a.select();
    const window = await a.windows(application);
    const observationId = await a.observe(window);
    const raise = await a.call('act', {
      target: window,
      observationId,
      action: { kind: 'window', change: { kind: 'raise' } },
    });
    expect(raise.outcome).toMatchObject({
      status: 'refused',
      code: 'invalid-request',
      dispatched: false,
    });
    expect(f.count('action')).toBe(0);
    expect(f.broker.snapshot(a.id).value.foregroundOwner).toBeNull();
  } finally {
    await f.close();
  }
});

it('retains foreground exclusion until backend settlement and never replays stopped input', async () => {
  const f = fixture(true);
  try {
    const policy = { mode: 'yolo', sandbox: 'full-access' } as const;
    const a = await f.owner('a', policy);
    const b = await f.owner('b', policy);
    const appA = await a.select();
    const appB = await b.select(1);
    const windowA = await a.windows(appA);
    const windowB = await b.windows(appB);
    const args = {
      target: windowA,
      observationId: await a.observe(windowA),
      action: { kind: 'press', key: 'right', holdMs: 800 },
    };
    const other = { ...args, target: windowB, observationId: await b.observe(windowB) };
    f.broker.configureStopShortcut(true);
    f.hold();
    const first = a.call('act', args, 'held');
    await vi.waitFor(() => {
      expect(f.count('action')).toBe(1);
    });
    const second = b.call('act', other);
    await vi.waitFor(() => {
      expect(f.broker.snapshot(b.id).value.operations).toHaveLength(2);
      expect(f.broker.snapshot(b.id).value.recentCalls.at(-1)?.phase).toBe('waiting');
    });
    expect(f.broker.snapshot(a.id).value.foregroundControl).toMatchObject({
      sessionId: a.id,
      application: { ref: appA },
      state: 'acting',
      stopShortcut: true,
    });
    expect(f.broker.snapshot(b.id).value.foregroundControl).toBeUndefined();
    f.event('takeover');
    expect((await first).outcome).toMatchObject({
      status: 'indeterminate',
      reason: 'cancelled-after-dispatch',
      exclusionHeld: true,
    });
    expect(f.broker.snapshot(a.id).value.foregroundControl).toMatchObject({
      state: 'paused',
      pauseReason: 'user-input',
    });
    expect(f.count('cancel')).toBe(1);
    expect((await a.call('act', args, 'held')).outcome.status).toBe('indeterminate');
    f.broker.stopForeground();
    expect(f.count('action')).toBe(1);
    f.settle();
    expect((await second).outcome.status).toBe('verified');
    expect(f.count('action')).toBe(2);
    expect(f.broker.snapshot(a.id).value.foregroundOwner).toBeNull();
  } finally {
    await f.close();
  }
});

it('waits for the current native control frame and distinguishes a Secure Input pause', async () => {
  const paint = Promise.withResolvers<Awaited<ReturnType<ControlSurface>>>();
  const surface = vi.fn<ControlSurface>(() => paint.promise);
  const f = fixture(false, surface);
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'full-access' });
    const application = await a.select();
    const target = await a.windows(application);
    if (!target) throw Error('Expected the fixture window.');
    const args = {
      target,
      observationId: await a.observe(target),
      action: { kind: 'press', key: 'right', holdMs: 800 },
    };
    f.hold();
    const held = a.call('act', args);
    await vi.waitFor(() => {
      expect(surface).toHaveBeenCalledWith(a.id, target, expect.any(AbortSignal));
    });
    expect(f.count('action')).toBe(0);
    const controlRevision = 51;
    paint.resolve(controlRevision);
    await vi.waitFor(() => {
      expect(f.requests.at(-1)).toMatchObject({ kind: 'action', controlRevision });
    });
    f.event('secure-input');
    const stopped = await held;
    expect(stopped.outcome).toMatchObject({ reason: 'cancelled-after-dispatch' });
    expect(f.broker.snapshot(a.id).value).toMatchObject({
      foregroundControl: { state: 'paused', pauseReason: 'secure-input', target },
      pausedTargets: [{ target: application, reason: 'secure-input' }],
    });
    expect(
      f.broker.record(a.id, stopped.automation.callId)?.incidents.map(({ kind }) => kind),
    ).toEqual(['secure-input']);
    expect(f.broker.handBack(a.id, target)).toMatchObject({ code: 'target-paused' });
    f.broker.stopForeground();
    f.settle();
    expect(f.broker.snapshot(a.id).value.foregroundControl).toBeUndefined();
  } finally {
    paint.resolve(undefined);
    await f.close();
  }
});

it('keeps a self-activation notice through the background operation without a foreground lease', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'full-access' });
    const application = await a.select();
    const target = await a.windows(application);
    if (!target) throw Error('Expected the fixture window.');
    expect(f.broker.resource(a.id, target.id)).toMatchObject({ application });
    const listener = vi.fn();
    const unsubscribe = f.broker.subscribeForegroundControl(listener);
    const args = {
      target,
      observationId: await a.observe(target),
      action: { kind: 'click', element: 2 },
    };
    f.hold();
    const acting = a.call('act', args);
    await vi.waitFor(() => {
      expect(f.count('action')).toBe(1);
    });
    f.event('target-self-activated');
    await vi.waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'came-forward', target }),
      );
    });
    f.settle(true);
    expect((await acting).outcome.status).toBe('verified');
    expect(f.broker.snapshot(a.id).value).toMatchObject({
      foregroundControl: { state: 'came-forward' },
      foregroundOwner: null,
    });
    expect((await a.call('release', { application })).outcome.status).toBe('verified');
    expect(listener).toHaveBeenLastCalledWith(undefined);
    unsubscribe();
  } finally {
    await f.close();
  }
});

it('reports loss of the native helper and holds exclusion until its child exits', async () => {
  const f = fixture();
  try {
    const a = await f.owner('a', { mode: 'yolo', sandbox: 'full-access' });
    const window = await a.windows(await a.select());
    const args = {
      target: window,
      observationId: await a.observe(window),
      action: { kind: 'press', key: 'right', holdMs: 800 },
    };
    f.hold();
    const running = a.call('act', args, 'lost-while-running');
    await vi.waitFor(() => {
      expect(f.count('action')).toBe(1);
    });
    f.loseConnection();
    const reply = await running;
    expect(reply.outcome).toEqual({
      status: 'indeterminate',
      reason: 'backend-lost',
      exclusionHeld: true,
    });
    expect(f.broker.record(a.id, reply.automation.callId)).toMatchObject({
      operationEnd: { reason: 'backend-lost' },
    });
    expect(f.broker.snapshot(a.id).value).toMatchObject({
      resources: [],
      foregroundOwner: a.id,
    });
    expect((await a.call('observe', { target: window })).outcome).toMatchObject({
      code: 'stale-target',
    });
    expect((await a.call('act', args, 'lost-while-running')).outcome).toEqual(reply.outcome);

    f.reap();
    await vi.waitFor(() => {
      expect(f.broker.snapshot(a.id).value.foregroundOwner).toBeNull();
    });
    expect((await a.call('act', args, 'lost-while-running')).outcome).toEqual({
      ...reply.outcome,
      exclusionHeld: false,
    });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.count('action')).toBe(1);
  } finally {
    await f.close();
  }
});

it('serializes background writes to one process across its owners’ window handles', async () => {
  const f = fixture();
  try {
    const policy = { mode: 'yolo', sandbox: 'workspace-write' } as const;
    const a = await f.owner('a', policy);
    const b = await f.owner('b', policy);
    const windowA = await a.windows(await a.select());
    const windowB = await b.windows(await b.select());
    const action = { kind: 'type', element: 1, text: 'Fixture' };
    const argsA = { target: windowA, observationId: await a.observe(windowA), action };
    const argsB = { target: windowB, observationId: await b.observe(windowB), action };
    f.hold();
    const first = a.call('act', argsA);
    await vi.waitFor(() => {
      expect(f.count('action')).toBe(1);
    });
    const second = b.call('act', argsB);
    await vi.waitFor(() => {
      expect(f.broker.snapshot(b.id).value.recentCalls.at(-1)?.phase).toBe('waiting');
    });
    f.broker.stop(a.id);
    const stopped = await first;
    expect(stopped.outcome).toMatchObject({ status: 'indeterminate', exclusionHeld: true });
    expect(f.broker.record(a.id, stopped.automation.callId)).toHaveProperty('computerAction', {
      kind: 'type',
      label: 'Fixture field',
    });
    expect(f.broker.snapshot(a.id).value.foregroundOwner).toBeNull();
    f.settle();
    expect((await second).outcome).toMatchObject({ code: 'stale-observation' });
    expect(f.count('action')).toBe(1);
  } finally {
    await f.close();
  }
});
