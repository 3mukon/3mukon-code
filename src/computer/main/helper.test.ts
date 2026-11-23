import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NativeHelper } from './helper';
import type { HelperChild } from './helper-wire';
import { NATIVE_WIRE_VERSION } from './native-protocol';

const request = z.object({
  kind: z.enum([
    'hello',
    'permissions',
    'request-permission',
    'applications',
    'observe',
    'preview',
    'action',
    'cancel',
    'control',
  ]),
  generation: z.uuid(),
  version: z.number(),
  id: z.number(),
});
const inventory = {
  applications: [
    {
      pid: 201,
      startedAt: 1700000000000,
      processStart: '1700000000000000',
      bundleId: 'test.fixture',
      name: 'Fixture',
    },
  ],
  truncated: false,
};
interface Allowed {
  accessibility: boolean;
  screenRecording: boolean;
  inputMonitoring: boolean;
}
const NONE: Allowed = { accessibility: false, screenRecording: false, inputMonitoring: false };
const BOTH: Allowed = { accessibility: true, screenRecording: true, inputMonitoring: false };
// The reply to an operation, by the kind of the request.
function operated(kind: 'observe' | 'preview', answer: { image?: string; missing?: string }) {
  if (answer.missing)
    return { status: 'refused', code: 'setup-required', permission: answer.missing };
  const image = {
    mediaType: 'image/jpeg',
    data: answer.image,
    width: 768,
    height: 480,
    capturedAt: 1,
  };
  const bounds = { x: 0, y: 0, width: 768, height: 480 };
  const id = randomUUID();
  return {
    status: 'verified',
    value:
      kind === 'preview'
        ? { frame: { id, bounds, image } }
        : { id, bounds, elements: [], truncated: false, image },
  };
}
function childFixture(
  options: {
    version?: number;
    answer?: 'none' | 'oversized' | 'bad-inventory' | 'hold-action';
    allowed?: Allowed;
    image?: string;
    missing?: 'accessibility' | 'screen-recording' | 'input-monitoring';
    stopShortcut?: boolean;
  } = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  let ended!: () => void;
  const exit = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const stop = vi.fn(() => {
    ended();
    return exit;
  });
  const counts: string[] = [];
  const asked: unknown[] = [];
  let held: z.infer<typeof request> | undefined;
  const child: HelperChild = { pid: 99, input, output, exit, stop };
  input.on('data', (chunk: Buffer) => {
    const data: unknown = JSON.parse(chunk.toString('utf8'));
    const call = request.parse(data);
    counts.push(call.kind);
    if (call.kind === 'request-permission') asked.push(data);
    if (call.kind === 'cancel' || call.kind === 'control') return;
    if (call.kind === 'action' && options.answer === 'hold-action') {
      held = call;
      return;
    }
    if (options.answer === 'none') return;
    const reply = {
      ...call,
      version: options.version ?? NATIVE_WIRE_VERSION,
      generation: call.generation.toUpperCase(),
      ...(call.kind === 'hello'
        ? { pid: child.pid, stopShortcut: options.stopShortcut ?? true }
        : call.kind === 'permissions'
          ? { permissions: options.allowed ?? BOTH }
          : call.kind === 'observe' || call.kind === 'preview'
            ? { result: operated(call.kind, options) }
            : call.kind === 'request-permission'
              ? { prompted: true }
              : {
                  inventory:
                    options.answer === 'bad-inventory'
                      ? {
                          applications: [{ ...inventory.applications[0], pid: 0 }],
                          truncated: false,
                        }
                      : inventory,
                }),
    };
    const encoded = options.answer === 'oversized' ? 'x'.repeat(32769) : JSON.stringify(reply);
    output.write(encoded.slice(0, 6));
    output.write(encoded.slice(6) + '\n');
  });
  return {
    child,
    stop,
    counts,
    asked,
    crash: ended,
    controlClick(generation: string, id: number, event: 'stop' | 'hand-back' | 'shortcut') {
      output.write(
        JSON.stringify({
          kind: 'control-command',
          version: NATIVE_WIRE_VERSION,
          generation,
          id,
          event,
        }) + '\n',
      );
    },
    settle() {
      if (!held) throw Error('No native action is running.');
      output.write(
        JSON.stringify({ ...held, kind: 'event', event: 'takeover' }) +
          '\n' +
          JSON.stringify({
            ...held,
            result: { status: 'indeterminate', reason: 'cancelled-after-dispatch' },
          }) +
          '\n',
      );
    },
  };
}

it('starts lazily, coalesces status requests, checks permissions on the child, and stops on close', async () => {
  const process = childFixture();
  const launch = vi.fn(() => Promise.resolve(process.child));
  const retired = vi.fn();
  const helper = new NativeHelper(launch, retired);
  expect(helper.status()).toMatchObject({ connection: 'idle', checkedAt: null, generation: null });
  expect(launch).not.toHaveBeenCalled();
  const [a, b] = await Promise.all([helper.check(), helper.check()]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({
    status: 'verified',
    value: {
      connection: 'ready',
      permissions: { accessibility: 'granted', screenRecording: 'granted' },
    },
  });
  expect(process.counts).toEqual(['hello', 'permissions']);
  await helper.check();
  expect(process.counts).toEqual(['hello', 'permissions', 'permissions']);
  const generation = helper.status().generation;
  await helper.close();
  expect(process.stop).toHaveBeenCalledOnce();
  expect(retired).toHaveBeenCalledWith(generation);
  expect((await helper.check()).status).toBe('refused');
  expect(launch).toHaveBeenCalledOnce();
});

it('accepts only current native control clicks, and the stop shortcut while a control shows, even with no outstanding tool request', async () => {
  const fixture = childFixture();
  const clicked = vi.fn();
  const helper = new NativeHelper(() => Promise.resolve(fixture.child), undefined, clicked);
  const frame = {
    window: randomUUID(),
    size: { width: 560, height: 48 },
    image: 'AA==',
    buttons: [],
  };
  expect(helper.control(1, frame)).toBe(false);
  try {
    await helper.check();
    const generation = helper.status().generation;
    if (!generation) throw Error('The fixture helper did not connect.');
    expect(helper.control(1, frame)).toBe(true);
    fixture.controlClick(generation, 1, 'stop');
    expect(helper.control(2, null)).toBe(true);
    fixture.controlClick(generation, 1, 'hand-back');
    fixture.controlClick(generation, 2, 'stop');
    fixture.controlClick(generation, 2, 'shortcut');
    expect(clicked).toHaveBeenCalledExactlyOnceWith(1, 'stop');
    // A press can come while a newer picture is on its way.
    expect(helper.control(3, frame)).toBe(true);
    fixture.controlClick(generation, 1, 'stop');
    fixture.controlClick(generation, 1, 'shortcut');
    expect(clicked.mock.calls).toEqual([
      [1, 'stop'],
      [1, 'shortcut'],
    ]);
    expect(helper.status().connection).toBe('ready');
  } finally {
    await helper.close();
  }
});

it.each([{ version: 1 }, { answer: 'oversized' as const }])(
  'refuses an incompatible or oversized handshake and drains its child',
  async (options) => {
    const process = childFixture(options);
    const helper = new NativeHelper(() => Promise.resolve(process.child));
    expect((await helper.check()).status).toBe('refused');
    expect(helper.status()).toMatchObject({ connection: 'protocol-mismatch', generation: null });
    expect(process.counts).toEqual(['hello']);
    expect(process.stop).toHaveBeenCalledOnce();
    await helper.close();
  },
);

it('discovers applications without a permissions query and serializes concurrent settings reads', async () => {
  const process = childFixture();
  const launch = vi.fn(() => Promise.resolve(process.child));
  const helper = new NativeHelper(launch);
  const first = helper.runningApplications();
  expect(helper.runningApplications()).toBe(first);
  expect(await first).toEqual({
    status: 'verified',
    value: { ...inventory, generation: helper.status().generation },
  });
  expect(process.counts).toEqual(['hello', 'applications']);
  expect(helper.status()).toMatchObject({
    connection: 'ready',
    checkedAt: null,
    permissions: { accessibility: 'unknown' },
  });
  const [applications, permissions] = await Promise.all([
    helper.runningApplications(),
    helper.check(),
  ]);
  expect(applications.status).toBe('verified');
  expect(permissions.status).toBe('verified');
  expect(process.counts).toEqual(['hello', 'applications', 'applications', 'permissions']);
  expect(launch).toHaveBeenCalledOnce();
  await helper.close();
});

it('retires a generation that sends an invalid application identity', async () => {
  const process = childFixture({ answer: 'bad-inventory' });
  const retired = vi.fn();
  const helper = new NativeHelper(() => Promise.resolve(process.child), retired);
  expect((await helper.runningApplications()).status).toBe('refused');
  expect(helper.status().connection).toBe('protocol-mismatch');
  expect(process.stop).toHaveBeenCalledOnce();
  expect(retired).toHaveBeenCalledOnce();
  await helper.close();
});

it('sends cancellation on the inherited pipe and waits for the native action to settle', async () => {
  const child = childFixture({ answer: 'hold-action' });
  const helper = new NativeHelper(() => Promise.resolve(child.child));
  try {
    const inventory = await helper.runningApplications();
    if (inventory.status !== 'verified') throw Error('Fixture helper did not start.');
    const controller = new AbortController();
    const event = vi.fn();
    const settled = vi.fn();
    const action = helper.operate(
      {
        kind: 'action',
        window: randomUUID(),
        scope: randomUUID(),
        operation: randomUUID(),
        observation: randomUUID(),
        action: { kind: 'press', key: 'right', holdMs: 800 },
      },
      { generation: inventory.value.generation, signal: controller.signal, event },
    );
    void action.then(settled);
    await vi.waitFor(() => {
      expect(child.counts.at(-1)).toBe('action');
    });
    controller.abort('stopped');
    expect(child.counts.at(-1)).toBe('cancel');
    expect(settled).not.toHaveBeenCalled();
    child.settle();
    expect(await action).toEqual({
      status: 'indeterminate',
      reason: 'cancelled-after-dispatch',
      exclusionHeld: false,
    });
    expect(event).toHaveBeenCalledExactlyOnceWith('takeover');
  } finally {
    await helper.close();
  }
});

it('keeps an unanswered mutation pending until the timed-out child is reaped', async () => {
  vi.useFakeTimers();
  const child = childFixture({ answer: 'hold-action' });
  let reaped!: () => void;
  child.stop.mockReturnValue(
    new Promise<void>((resolve) => {
      reaped = resolve;
    }),
  );
  const helper = new NativeHelper(() => Promise.resolve(child.child));
  try {
    const inventory = await helper.runningApplications();
    if (inventory.status !== 'verified') throw Error('Fixture helper did not start.');
    const settled = vi.fn();
    const result = helper.operate(
      {
        kind: 'action',
        window: randomUUID(),
        scope: randomUUID(),
        operation: randomUUID(),
        observation: randomUUID(),
        action: { kind: 'press', key: 'right' },
      },
      { generation: inventory.value.generation, signal: new AbortController().signal },
    );
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.counts).toEqual(['hello', 'applications', 'action']);
    expect(child.stop).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    reaped();
    child.crash();
    expect(await result).toEqual({
      status: 'indeterminate',
      reason: 'timeout',
      exclusionHeld: false,
    });
  } finally {
    reaped();
    await helper.close();
    vi.useRealTimers();
  }
});

it('invalidates a crashed generation and reaps it before opening a replacement', async () => {
  const first = childFixture();
  const second = childFixture();
  const retired = vi.fn();
  const launch = vi
    .fn<() => Promise<HelperChild>>()
    .mockResolvedValueOnce(first.child)
    .mockResolvedValueOnce(second.child);
  const helper = new NativeHelper(launch, retired);
  await helper.check();
  const before = helper.status().generation;
  first.crash();
  await Promise.resolve();
  expect(launch).toHaveBeenCalledOnce();
  expect(helper.status()).toMatchObject({
    connection: 'unavailable',
    generation: null,
    permissions: { accessibility: 'unavailable', screenRecording: 'unavailable' },
  });
  expect(retired).toHaveBeenCalledWith(before);
  expect((await helper.restart()).status).toBe('verified');
  expect(helper.status().generation).not.toBe(before);
  await helper.close();
  expect(second.stop).toHaveBeenCalledOnce();
});

it('times out a silent helper and prevents an in-flight launch from surviving shutdown', async () => {
  vi.useFakeTimers();
  try {
    const silent = childFixture({ answer: 'none' });
    const helper = new NativeHelper(() => Promise.resolve(silent.child));
    const checked = helper.check();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await checked).status).toBe('refused');
    expect(silent.stop).toHaveBeenCalledOnce();
    await helper.close();
    const delayed = childFixture();
    let complete!: (child: HelperChild) => void;
    const pending = new Promise<HelperChild>((resolve) => {
      complete = resolve;
    });
    const launch = vi.fn(() => pending);
    const closing = new NativeHelper(launch);
    const response = closing.check();
    await Promise.resolve();
    expect(launch).toHaveBeenCalledOnce();
    const stopped = closing.close();
    complete(delayed.child);
    await stopped;
    expect((await response).status).toBe('refused');
    expect(delayed.counts).toEqual([]);
    expect(delayed.stop).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('has macOS ask the user for the permission it is given', async () => {
  const fixture = childFixture();
  const helper = new NativeHelper(() => Promise.resolve(fixture.child));
  try {
    expect(await helper.request('screen-recording')).toEqual({
      status: 'verified',
      value: { prompted: true },
    });
    expect(fixture.counts).toEqual(['hello', 'request-permission']);
    expect(fixture.asked).toEqual([
      expect.objectContaining({ kind: 'request-permission', permission: 'screen-recording' }),
    ]);
  } finally {
    await helper.close();
  }
  expect((await helper.request('accessibility')).status).toBe('refused');
});

// A helper that has been running, and the processes that start after it.
async function running(
  options: Parameters<typeof childFixture>[0],
  ...later: Parameters<typeof childFixture>[0][]
) {
  const first = childFixture(options);
  const fresh = later.map((each) => childFixture(each));
  const children = [first, ...fresh];
  const launch = vi.fn(() => {
    const next = children.shift();
    return next ? Promise.resolve(next.child) : Promise.reject(new Error('No helper starts.'));
  });
  const helper = new NativeHelper(launch);
  const discovered = await helper.runningApplications();
  if (discovered.status !== 'verified') throw Error('The fixture helper did not start.');
  return { helper, first, fresh, launch, generation: discovered.value.generation };
}

it('says that a permission takes effect after a restart, from what a process that starts now has', async () => {
  const { helper, first, fresh, launch } = await running(
    { allowed: NONE },
    { allowed: BOTH },
    { allowed: BOTH },
  );
  try {
    expect(await helper.check()).toMatchObject({
      status: 'verified',
      value: {
        connection: 'ready',
        permissions: {
          accessibility: 'restart-required',
          screenRecording: 'restart-required',
          restartRequired: true,
        },
      },
    });
    expect(fresh[0]?.counts).toEqual(['hello', 'permissions']);
    expect(fresh[0]?.stop).toHaveBeenCalledOnce();
    expect(first.stop).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(await helper.restart()).toMatchObject({
      status: 'verified',
      value: {
        permissions: {
          accessibility: 'granted',
          screenRecording: 'granted',
          restartRequired: false,
        },
      },
    });
    expect(first.stop).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledTimes(3);
  } finally {
    await helper.close();
  }
});

it.each([
  { name: 'has not allowed it', later: [{ allowed: NONE }] },
  { name: 'starts no process', later: [] },
  { name: 'gets no answer it knows', later: [{ version: 1 }] },
])('leaves a permission as not granted where macOS $name', async ({ later }) => {
  const { helper } = await running({ allowed: NONE }, ...later);
  try {
    expect(await helper.check()).toMatchObject({
      status: 'verified',
      value: {
        connection: 'ready',
        permissions: {
          accessibility: 'not-granted',
          screenRecording: 'not-granted',
          restartRequired: false,
        },
      },
    });
  } finally {
    await helper.close();
  }
});

it('starts no other process where the helper has what it needs, or has only just started', async () => {
  const needed = await running({ allowed: BOTH }, { allowed: BOTH });
  await needed.helper.check();
  expect(needed.launch).toHaveBeenCalledOnce();
  await needed.helper.close();

  const started = childFixture({ allowed: NONE });
  const launch = vi.fn(() => Promise.resolve(started.child));
  const helper = new NativeHelper(launch);
  expect(await helper.check()).toMatchObject({
    value: { permissions: { accessibility: 'not-granted', screenRecording: 'not-granted' } },
  });
  expect(launch).toHaveBeenCalledOnce();
  await helper.close();
});

it('ends the process that reads the permissions as the app quits', async () => {
  vi.useFakeTimers();
  try {
    const { helper, fresh } = await running({ allowed: NONE }, { answer: 'none' });
    const checked = helper.check();
    await vi.waitFor(() => {
      expect(fresh[0]?.counts).toEqual(['hello']);
    });
    // It waits for no answer.
    await helper.close();
    expect(fresh[0]?.stop).toHaveBeenCalled();
    expect((await checked).status).toBe('refused');
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    name: 'the permission',
    later: NONE,
    requirement: { kind: 'permission', permission: 'screen-recording' },
  },
  { name: 'the helper’s restart', later: BOTH, requirement: { kind: 'restart-helper' } },
])(
  'refuses an operation for $name, as a process that starts now has it',
  async ({ later, requirement }) => {
    const { helper, generation } = await running(
      { allowed: { ...NONE, accessibility: true }, missing: 'screen-recording' },
      { allowed: later },
    );
    try {
      expect(
        await helper.operate(
          {
            kind: 'observe',
            window: randomUUID(),
            scope: randomUUID(),
            image: true,
            operation: randomUUID(),
          },
          { generation, signal: new AbortController().signal },
        ),
      ).toEqual({
        status: 'refused',
        code: 'setup-required',
        dispatched: false,
        detail: { kind: 'setup', requirement },
      });
    } finally {
      await helper.close();
    }
  },
);

const preview = {
  kind: 'preview' as const,
  application: { pid: 201, startedAt: 1, processStart: '1', bundleId: 'test.fixture' },
  window: randomUUID(),
  operation: randomUUID(),
};

it('starts no process for a preview that lacks a permission', async () => {
  const { helper, launch, generation } = await running(
    { allowed: NONE, missing: 'accessibility' },
    { allowed: BOTH },
  );
  try {
    expect(
      await helper.operate(preview, { generation, signal: new AbortController().signal }),
    ).toMatchObject({
      status: 'refused',
      detail: { requirement: { kind: 'permission', permission: 'accessibility' } },
    });
    expect(launch).toHaveBeenCalledOnce();
  } finally {
    await helper.close();
  }
});

it('takes a preview whose image is as large as an observation’s', async () => {
  const image = 'A'.repeat(400 * 1024);
  const { helper, generation } = await running({ image });
  try {
    expect(
      await helper.operate(preview, { generation, signal: new AbortController().signal }),
    ).toMatchObject({ status: 'verified', value: { frame: { image: { data: image } } } });
    expect(helper.status().connection).toBe('ready');
  } finally {
    await helper.close();
  }
});

it('says whether macOS registers the stop shortcut, as each helper reports it', async () => {
  const first = childFixture({ stopShortcut: false });
  const second = childFixture();
  const launch = vi
    .fn<() => Promise<HelperChild>>()
    .mockResolvedValueOnce(first.child)
    .mockResolvedValueOnce(second.child);
  const registers = vi.fn();
  const helper = new NativeHelper(launch, undefined, undefined, registers);
  await helper.runningApplications();
  expect(registers.mock.calls).toEqual([[false]]);
  await helper.runningApplications();
  await helper.restart();
  expect(registers.mock.calls).toEqual([[false], [true]]);
  await helper.close();
});
