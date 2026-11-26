import { describe, expect, it, vi } from 'vitest';
import {
  codexSignIn,
  isSignInError,
  readCodexAccount,
  resetCodexLimits,
  updatedWindows,
} from './account';
import type { Rpc } from './rpc';

// An app-server that answers each method as the test gives, and records what it was asked.
function rpc(answers: Record<string, unknown>) {
  const asked: [string, unknown][] = [];
  const fake: Rpc = {
    request<Result>(method: string, params: unknown) {
      asked.push([method, params]);
      return Promise.resolve(answers[method] as Result);
    },
    notify: vi.fn(),
    close: () => Promise.resolve(),
  };
  return { fake, asked };
}

const limits = {
  rateLimits: {
    primary: { usedPercent: 84, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: null },
    credits: null,
  },
  rateLimitResetCredits: { availableCount: 2, credits: null },
};

describe('Codex’s account', () => {
  it('tells how Codex is signed in from its account, never reading more of it', () => {
    const chatgpt = { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' };
    expect(codexSignIn({ account: chatgpt, requiresOpenaiAuth: true })).toEqual({
      state: 'signed-in',
      method: 'subscription',
    });
    expect(codexSignIn({ account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false })).toEqual({
      state: 'signed-in',
      method: 'backend',
    });
    // Another kind of account is a key, the one way left.
    expect(codexSignIn({ account: { type: 'other' }, requiresOpenaiAuth: true })).toEqual({
      state: 'signed-in',
      method: 'key',
    });
    expect(codexSignIn({ account: null, requiresOpenaiAuth: true })).toEqual({
      state: 'signed-out',
    });
    expect(codexSignIn({ account: null, requiresOpenaiAuth: false })).toEqual({
      state: 'signed-in',
      method: 'backend',
    });
    expect(codexSignIn({ account: 'chatgpt' })).toEqual({ state: 'unknown' });
  });

  it('reads a subscription’s windows and resets, without the resets’ details, and nothing more for other sign-ins', async () => {
    const subscribed = rpc({
      'account/read': { account: { type: 'chatgpt' }, requiresOpenaiAuth: true },
      'account/rateLimits/read': limits,
    });
    expect(await readCodexAccount(subscribed.fake, true)).toEqual({
      signIn: { state: 'signed-in', method: 'subscription' },
      usage: {
        windows: [
          { span: 'five-hour', used: 84, resetsAt: 1_800_000_000_000 },
          { span: 'week', used: 12, resetsAt: null },
        ],
        resets: 2,
      },
    });
    expect(subscribed.asked).toEqual([
      ['account/read', {}],
      ['account/rateLimits/read', { excludeResetCreditDetails: true }],
    ]);
    const signInOnly = rpc({
      'account/read': { account: { type: 'chatgpt' }, requiresOpenaiAuth: true },
    });
    await readCodexAccount(signInOnly.fake, false);
    expect(signInOnly.asked.map(([method]) => method)).toEqual(['account/read']);
    const signedOut = rpc({ 'account/read': { account: null, requiresOpenaiAuth: true } });
    expect(await readCodexAccount(signedOut.fake, true)).toEqual({
      signIn: { state: 'signed-out' },
    });
    expect(signedOut.asked).toHaveLength(1);
    // Limits of another shape leave the usage unread, saying so.
    const changed = rpc({
      'account/read': { account: { type: 'chatgpt' }, requiresOpenaiAuth: true },
      'account/rateLimits/read': { limits: [] },
    });
    expect(await readCodexAccount(changed.fake, true)).toEqual({
      signIn: { state: 'signed-in', method: 'subscription' },
      usageProblem: 'unreadable',
    });
    // A refused request says that the sign-in could not fetch them, another that Codex could not.
    for (const [message, problem] of [
      ['unexpected status 401 Unauthorized', 'refused'],
      ['stream disconnected before completion', 'unreachable'],
    ] as const) {
      const failing = rpc({
        'account/read': { account: { type: 'chatgpt' }, requiresOpenaiAuth: true },
      });
      const request = failing.fake.request.bind(failing.fake);
      failing.fake.request = <Result>(method: string, params: unknown) =>
        method === 'account/rateLimits/read'
          ? Promise.reject(new Error(message))
          : request<Result>(method, params);
      expect(await readCodexAccount(failing.fake, true)).toEqual({
        signIn: { state: 'signed-in', method: 'subscription' },
        usageProblem: problem,
      });
    }
  });

  it('takes the windows of a rate-limit update and tells a turn refused for want of a sign-in', () => {
    expect(
      updatedWindows({
        rateLimits: { primary: null, secondary: { usedPercent: 101, windowDurationMins: 90 } },
      }),
    ).toEqual([{ span: 90, used: 100, resetsAt: null }]);
    expect(updatedWindows({ rateLimits: 'none' })).toEqual([]);
    expect(isSignInError({ error: { message: 'no', codexErrorInfo: 'unauthorized' } })).toBe(true);
    expect(isSignInError({ error: { message: 'no', codexErrorInfo: 'usageLimitExceeded' } })).toBe(
      false,
    );
  });

  it('spends a reset as one attempt and says what it did', async () => {
    const codex = rpc({ 'account/rateLimitResetCredit/consume': { outcome: 'nothingToReset' } });
    expect(await resetCodexLimits(codex.fake)).toBe('nothing-to-reset');
    const [[method, params]] = codex.asked as [[string, { idempotencyKey: string }]];
    expect(method).toBe('account/rateLimitResetCredit/consume');
    expect(params.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
