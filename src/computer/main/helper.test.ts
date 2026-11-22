import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NativeHelper } from './helper';
import type { HelperChild } from './helper-wire';
import { NATIVE_WIRE_VERSION } from './native-protocol';

const request = z.object({
  kind: z.enum(['hello', 'permissions', 'applications', 'action', 'cancel', 'control']),
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
function childFixture(
  options: {
    version?: number;
    answer?: 'none' | 'oversized' | 'bad-inventory' | 'hold-action';
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
  let held: z.infer<typeof request> | undefined;
  const child: HelperChild = { pid: 99, input, output, exit, stop };
  input.on('data', (chunk: Buffer) => {
    const data: unknown = JSON.parse(chunk.toString('utf8'));
    const call = request.parse(data);
    counts.push(call.kind);
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
        ? { pid: child.pid }
        : call.kind === 'permissions'
          ? {
              permissions: {
                accessibility: false,
                screenRecording: true,
                inputMonitoring: false,
              },
            }
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
    crash: ended,
    controlClick(generation: string, id: number, event: 'stop' | 'hand-back') {
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
      permissions: { accessibility: 'not-granted', screenRecording: 'granted' },
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

it('accepts only current native control clicks even with no outstanding tool request', async () => {
  const fixture = childFixture();
  const clicked = vi.fn();
  const helper = new NativeHelper(() => Promise.resolve(fixture.child), undefined, clicked);
  const frame = { bounds: { x: 10, y: 20, width: 560, height: 48 }, image: 'AA==', buttons: [] };
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
    expect(clicked).toHaveBeenCalledExactlyOnceWith(1, 'stop');
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
