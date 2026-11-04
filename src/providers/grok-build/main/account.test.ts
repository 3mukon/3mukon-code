import type { ClientConnection } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  AUTH_INFO,
  BILLING,
  grokSignIn,
  grokWindows,
  isSignInError,
  readGrokAccount,
} from './account';

// The answer of Grok Build 1.0.70's billing method for a plan with a weekly period, with the share
// of credits used that a plan with included credits adds.
const billing = (creditUsagePercent?: number) => ({
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-11-02T00:00:00Z',
      end: '2026-11-09T00:00:00Z',
    },
    onDemandCap: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodEnd: '2026-12-01T00:00:00Z',
    ...(creditUsagePercent === undefined ? {} : { creditUsagePercent }),
  },
  subscription_tier: 'Free',
});

describe('Grok Build’s account', () => {
  it('tells how Grok is signed in from the method it names, never reading more', () => {
    expect(grokSignIn({ methodId: 'cached_token', email: 'someone@example.com' })).toEqual({
      state: 'signed-in',
      method: 'subscription',
    });
    expect(grokSignIn({ methodId: 'another' })).toEqual({ state: 'signed-in', method: 'key' });
    expect(grokSignIn({ methodId: null })).toEqual({ state: 'signed-out' });
    expect(grokSignIn({})).toEqual({ state: 'signed-out' });
    expect(grokSignIn('signed in')).toEqual({ state: 'unknown' });
  });

  it('makes the plan’s current period a window, with the share of its credits used where given', () => {
    const end = Date.parse('2026-11-09T00:00:00Z');
    expect(grokWindows(billing())).toEqual([{ span: 'week', used: null, resetsAt: end }]);
    expect(grokWindows(billing(64.5))).toEqual([{ span: 'week', used: 64.5, resetsAt: end }]);
    expect(
      grokWindows({
        config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' }, creditUsagePercent: 10 },
      }),
    ).toEqual([{ span: 'month', used: 10, resetsAt: null }]);
    expect(grokWindows({ config: {} })).toBeUndefined();
    expect(grokWindows({ plan: 'Free' })).toBeUndefined();
  });

  it('asks for the billing only for a subscription, and tells a prompt refused for want of a sign-in', async () => {
    const asked: string[] = [];
    const connection = (info: unknown) =>
      ({
        agent: {
          request: (method: string) => {
            asked.push(method);
            return Promise.resolve(method === AUTH_INFO ? info : billing(30));
          },
        },
      }) as unknown as ClientConnection;
    expect(await readGrokAccount(connection({ methodId: 'cached_token' }), true)).toMatchObject({
      usage: { windows: [{ span: 'week', used: 30 }] },
    });
    expect(asked).toEqual([AUTH_INFO, BILLING]);
    asked.length = 0;
    expect(await readGrokAccount(connection({ methodId: null }), true)).toEqual({
      signIn: { state: 'signed-out' },
    });
    expect(asked).toEqual([AUTH_INFO]);
    // A billing answer of another shape, or a refused one, says why the usage was not read.
    const answering = (billingAnswer: () => Promise<unknown>) =>
      ({
        agent: {
          request: (method: string) =>
            method === AUTH_INFO ? Promise.resolve({ methodId: 'cached_token' }) : billingAnswer(),
        },
      }) as unknown as ClientConnection;
    expect(
      await readGrokAccount(
        answering(() => Promise.resolve({ plan: 'Free' })),
        true,
      ),
    ).toEqual({
      signIn: { state: 'signed-in', method: 'subscription' },
      usageProblem: 'unreadable',
    });
    expect(
      await readGrokAccount(
        answering(() => Promise.reject(new Error('Billing data requires auth with grok.com.'))),
        true,
      ),
    ).toMatchObject({ usageProblem: 'refused' });
    expect(isSignInError({ code: -32000, message: 'Authentication required' })).toBe(true);
    expect(isSignInError(new Error('Internal error'))).toBe(false);
  });
});
