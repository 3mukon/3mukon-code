import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AutomationCallRecord, AutomationSnapshot } from '../../sessions/shared/automation';
import type { AutomationBridge } from '../../toolset/shared/automation';
import { FakeAutomationBridge } from '../../toolset/shared/automation-fake';
import { follow, useAutomation } from './use-automation';

function automationSnapshot(
  sessionId: string,
  recentCalls: AutomationCallRecord[] = [],
): AutomationSnapshot {
  return {
    sessionId,
    policy: { mode: 'auto', sandbox: 'workspace-write' },
    policyEpoch: 1,
    phase: 'idle',
    resources: [],
    operations: [],
    grants: [],
    pendingApprovals: [],
    foregroundOwner: null,
    availability: { tools: 'ready', images: 'unknown' },
    endedGrants: [],
    recentCalls,
    presentationNotices: [],
  };
}

const settle = () => act(() => Promise.resolve());

describe('follow', () => {
  it('reads the snapshot after listening, keeps it current by events and reads it again after a gap', async () => {
    const fake = new FakeAutomationBridge();
    fake.seed(automationSnapshot('s1'));
    const seen: AutomationSnapshot[] = [];
    const stop = follow(fake, 's1', (snapshot) => seen.push(snapshot));
    await settle();
    expect(seen.map((snapshot) => snapshot.phase)).toEqual(['idle']);
    fake.publish('s1', { kind: 'state', state: { ...automationSnapshot('s1'), phase: 'acting' } });
    expect(seen.at(-1)?.phase).toBe('acting');
    fake.skipSequence('s1');
    fake.publish('s1', {
      kind: 'state',
      state: { ...automationSnapshot('s1'), phase: 'observing' },
    });
    await settle();
    expect(seen.at(-1)?.phase).toBe('observing');
    stop();
    fake.publish('s1', { kind: 'state', state: { ...automationSnapshot('s1'), phase: 'idle' } });
    expect(seen.at(-1)?.phase).toBe('observing');
  });

  it('waits for the first event of a session main has not bound yet, then reads it', async () => {
    const fake = new FakeAutomationBridge();
    const seen: AutomationSnapshot[] = [];
    follow(fake, 's1', (snapshot) => seen.push(snapshot));
    await settle();
    expect(seen).toEqual([]);
    fake.seed(automationSnapshot('s1'));
    fake.publish('s1', { kind: 'state', state: { ...automationSnapshot('s1'), phase: 'acting' } });
    await settle();
    expect(seen.at(-1)?.phase).toBe('acting');
  });
});

describe('useAutomation', () => {
  it('follows the sessions shown, and stops following one once it no longer is', async () => {
    const fake = new FakeAutomationBridge();
    fake.seed(automationSnapshot('s1'));
    fake.seed(automationSnapshot('s2'));
    const stopped: string[] = [];
    const bridge: AutomationBridge = {
      ...Object.fromEntries(
        (
          [
            'snapshot',
            'callRecord',
            'callFrames',
            'icon',
            'capabilities',
            'answer',
            'stop',
            'endOperation',
            'endGrant',
          ] as const
        ).map((name) => [name, fake[name].bind(fake)]),
      ),
      subscribe: (id, listener) => {
        const stop = fake.subscribe(id, listener);
        return () => {
          stopped.push(id);
          stop();
        };
      },
    } as AutomationBridge;
    const { result, rerender } = renderHook(({ ids }) => useAutomation(bridge, ids), {
      initialProps: { ids: ['s1', 's2', 's1'] },
    });
    await settle();
    expect([...result.current.keys()].sort()).toEqual(['s1', 's2']);
    rerender({ ids: ['s2'] });
    expect([...result.current.keys()]).toEqual(['s2']);
    expect(stopped).toEqual(['s1']);
  });
});
