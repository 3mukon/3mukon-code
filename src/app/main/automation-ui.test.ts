import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AutomationBroker } from '../../toolset/main/broker';
import { automationUi, AutomationSubscriptions } from './automation-ui';

let broker: AutomationBroker;
const known = new Set(['a', 'b', 'past']);
const interrupt = vi.fn(() => Promise.resolve());
const policy = { mode: 'auto' as const, sandbox: 'read-only' as const };
beforeEach(async () => {
  interrupt.mockReset().mockResolvedValue();
  broker = new AutomationBroker([
    {
      name: 'panel_fixture',
      family: 'panel',
      annotations: { readOnlyHint: false, openWorldHint: false },
      description: 'Synthetic',
      inputSchema: z.object({}),
      availability: { tools: 'ready', images: 'unknown' },
      plan: () => ({
        operation: null,
        effect: 'present',
        delivery: 'background',
        mayActivate: false,
      }),
      execute: () => Promise.resolve({ outcome: { status: 'verified', value: null } }),
    },
  ]);
  await broker.bind('a', process.cwd(), policy);
  await broker.bind('b', process.cwd(), policy);
});
afterEach(async () => {
  await broker.close();
});
const ui = () => automationUi(broker, { has: (id) => known.has(id), interrupt });

it('reads current call data through the session owner, and scopes user answers and stop to that owner', async () => {
  const bridge = ui();
  broker.beginTurn('a');
  const receipt = await broker.dispatch(
    broker.openAccess('a'),
    'panel_fixture',
    {},
    { actionId: 'once' },
  );
  const id = receipt.automation.callId;
  expect(await bridge.callRecord('a', id)).toMatchObject({
    status: 'verified',
    value: { sessionId: 'a', callId: id },
  });
  expect(await bridge.callRecord('b', id)).toMatchObject({ code: 'not-found' });
  expect(await bridge.callFrames('a', id)).toEqual({ status: 'verified', value: [] });
  expect(await bridge.callFrames('b', id)).toMatchObject({ code: 'not-found' });
  expect(await bridge.icon('a', 'foreign')).toMatchObject({ code: 'not-found' });
  expect((await bridge.snapshot('a')).value.recentCalls).toHaveLength(1);
  expect((await bridge.capabilities('a')).policy).toEqual(policy);
  expect(await bridge.answer('b', 'foreign', { decision: 'allow-once' })).toMatchObject({
    code: 'not-found',
  });
  expect(await bridge.endOperation('b', 'foreign')).toMatchObject({ code: 'not-found' });
  expect(await bridge.endGrant('b', 'foreign')).toMatchObject({ code: 'not-found' });
  const stop = vi.spyOn(broker, 'stop');
  expect(await bridge.stop('a')).toEqual({ status: 'verified', value: null });
  expect(stop).toHaveBeenCalledWith('a');
  expect(interrupt).toHaveBeenCalledExactlyOnceWith('a');
  interrupt.mockRejectedValueOnce(Error('Provider lost'));
  expect(await bridge.stop('a')).toMatchObject({ status: 'indeterminate' });
});

it('rejects unknown sessions and keeps historical subscriptions ready for a later bind', async () => {
  const bridge = ui();
  // Possession of a broker owner alone is not app membership.
  await broker.bind('foreign', process.cwd(), policy);
  await expect(bridge.snapshot('foreign')).rejects.toThrow('no such session');
  expect(await bridge.stop('foreign')).toMatchObject({ code: 'not-found' });
  expect(() => bridge.subscribe('foreign', vi.fn())).toThrow('no such session');
  const listener = vi.fn();
  const stop = bridge.subscribe('past', listener);
  await expect(bridge.snapshot('past')).rejects.toThrow('not available');
  await broker.bind('past', process.cwd(), policy);
  expect(listener).toHaveBeenCalledOnce();
  expect((await bridge.snapshot('past')).value.sessionId).toBe('past');
  stop();
  const unavailable = automationUi(undefined, { has: (id) => known.has(id), interrupt });
  await expect(unavailable.snapshot('a')).rejects.toThrow('not available');
  expect(await unavailable.callRecord('a', 'call')).toMatchObject({ code: 'not-found' });
});

it('ends a page’s subscriptions on loss without ending another page’s or session’s', () => {
  const subscriptions = new AutomationSubscriptions(ui());
  const first = vi.fn();
  const second = vi.fn();
  const other = vi.fn();
  subscriptions.add(1, 'same-key', 'a', first);
  subscriptions.add(2, 'same-key', 'a', second);
  subscriptions.add(1, 'other', 'b', other);
  expect(() => {
    subscriptions.add(1, 'same-key', 'b', vi.fn());
  }).toThrow('conflict');
  broker.stop('a');
  expect(first).toHaveBeenCalled();
  expect(second).toHaveBeenCalled();
  expect(other).not.toHaveBeenCalled();
  subscriptions.release(1);
  first.mockClear();
  second.mockClear();
  broker.endTurn('a');
  broker.stop('b');
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalled();
  expect(other).not.toHaveBeenCalled();
  subscriptions.remove(2, 'same-key');
  second.mockClear();
  broker.stop('a');
  expect(second).not.toHaveBeenCalled();
});
