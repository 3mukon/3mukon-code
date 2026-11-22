import { describe, expect, it } from 'vitest';
import type { AutomationLiveState, Operation, TargetSummary } from '../shared/automation';
import { callState, deliveryOn, sharingWords, targetName, type UseCall } from './automation-labels';

const tab: TargetSummary = {
  ref: { id: 'tab-1', kind: 'browser-tab', generation: 1 },
  owner: 's1',
  name: 'Pricing · Example',
  address: 'https://example.com/pricing/',
  sharing: 'none',
  browser: 'embedded',
};

function call(fields: Partial<UseCall>): UseCall {
  return {
    callId: 'c1',
    sessionId: 's1',
    turnId: 'turn-1',
    accessGeneration: 1,
    revision: 1,
    toolName: 'browser_navigate',
    operationId: null,
    operationEnd: null,
    grantId: null,
    grantEnd: null,
    approval: null,
    incidents: [],
    startedAt: 1,
    completedAt: 2,
    phase: 'settled',
    outcome: { status: 'verified', value: null },
    frames: [],
    framesState: 'available',
    providerEntry: null,
    family: 'browser',
    target: { state: 'resolved', summary: tab },
    sharing: 'none',
    delivery: 'background',
    ...fields,
  };
}

describe('targetName', () => {
  it('names a page by its host, or its host and path, and anything else by its name', () => {
    expect(targetName(tab)).toBe('example.com');
    expect(targetName(tab, true)).toBe('example.com/pricing');
    expect(targetName({ ...tab, address: 'https://example.com/' }, true)).toBe('example.com');
    expect(targetName({ ...tab, address: undefined, name: 'Mail' })).toBe('Mail');
    expect(targetName({ ...tab, address: 'not a URL' })).toBe('Pricing · Example');
    expect(targetName({ ...tab, address: undefined, name: '' })).toBeNull();
  });
});

describe('sharingWords', () => {
  it('names the sharing level, and Chrome with its profile', () => {
    expect(sharingWords('none')).toEqual({ key: 'none' });
    expect(sharingWords('app', 'embedded')).toEqual({ key: 'app' });
    expect(sharingWords('global', 'chrome', { id: 'p', name: 'Personal' })).toEqual({
      key: 'chrome',
      profile: 'Personal',
    });
    expect(sharingWords('global', 'chrome', null)).toEqual({ key: 'chrome', profile: null });
    expect(sharingWords('global', 'embedded')).toBeNull();
    expect(sharingWords(null)).toBeNull();
    expect(sharingWords(undefined)).toBeNull();
  });
});

describe('deliveryOn', () => {
  const operation = (fields: Partial<Operation>): Operation => ({
    id: 'op-1',
    owner: 's1',
    turn: 'turn-1',
    accessGeneration: 1,
    target: { id: 'app-1', kind: 'application', generation: 1 },
    kind: 'application-foreground',
    policyEpoch: 1,
    state: 'active',
    targetMayActivate: false,
    deadline: 0,
    ...fields,
  });
  const state = (operations: Operation[]) => ({ operations }) as unknown as AutomationLiveState;
  const app = { id: 'app-1', kind: 'application', generation: 1 } as const;

  it('counts work in the foreground only while a foreground operation on the target lasts', () => {
    expect(deliveryOn(state([operation({})]), app)).toBe('foreground');
    expect(deliveryOn(state([operation({ state: 'ended' })]), app)).toBe('background');
    expect(deliveryOn(state([operation({ kind: 'application-background' })]), app)).toBe(
      'background',
    );
    expect(deliveryOn(state([operation({})]), { ...app, id: 'app-2' })).toBe('background');
  });
});

describe('callState', () => {
  it('tells a checked effect from one sent without a check, and says what may have happened', () => {
    expect(callState(call({}))).toEqual({ status: 'completed', note: null });
    expect(
      callState(call({ outcome: { status: 'dispatched', evidence: 'not-verified' } })),
    ).toEqual({ status: 'completed', note: { key: 'notChecked' } });
    expect(
      callState(call({ outcome: { status: 'cancelled-before-dispatch', effects: 'none' } })),
    ).toEqual({ status: 'completed', note: { key: 'cancelled' } });
    expect(
      callState(call({ outcome: { status: 'partial', completed: ['a'], remaining: 'unknown' } })),
    ).toEqual({ status: 'failed', note: { key: 'partial' } });
    expect(
      callState(
        call({
          outcome: { status: 'indeterminate', reason: 'timeout', exclusionHeld: false },
        }),
      ),
    ).toEqual({ status: 'failed', note: { key: 'indeterminate', reason: 'timeout' } });
    expect(
      callState(
        call({
          outcome: {
            status: 'refused',
            code: 'denied',
            dispatched: false,
            detail: { kind: 'denial', message: 'Use the CSV' },
          },
        }),
      ),
    ).toEqual({
      status: 'failed',
      note: { key: 'refused', code: 'denied', detail: { kind: 'denial', message: 'Use the CSV' } },
    });
  });

  it('shows a call that has not settled as waiting or running', () => {
    expect(callState(call({ outcome: null, phase: 'received' }))).toEqual({
      status: 'pending',
      note: null,
    });
    expect(callState(call({ outcome: null, phase: 'dispatched' }))).toEqual({
      status: 'running',
      note: null,
    });
    const waiting = call({
      outcome: null,
      phase: 'waiting',
      approval: {
        request: {} as never,
        answer: null,
        answeredAt: null,
        grantId: null,
      },
    });
    expect(callState(waiting)).toEqual({ status: 'pending', note: { key: 'waitingApproval' } });
  });
});
