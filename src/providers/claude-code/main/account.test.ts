import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { claudeSignIn, eventWindows, experimentalWindows } from './account';

const usage = (rateLimits: SDKControlGetUsageResponse['rate_limits'], available = true) =>
  ({
    subscription_type: 'pro',
    rate_limits_available: available,
    rate_limits: rateLimits,
  }) as SDKControlGetUsageResponse;

describe('Claude Code’s account', () => {
  it('tells how Claude Code is signed in from its own status, never reading the account', () => {
    const status = { loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com' };
    expect(claudeSignIn({ ...status, apiProvider: 'firstParty', subscriptionType: 'pro' })).toEqual(
      { state: 'signed-in', method: 'subscription' },
    );
    expect(claudeSignIn({ ...status, apiProvider: 'bedrock' })).toEqual({
      state: 'signed-in',
      method: 'backend',
    });
    // Signed in to Anthropic's own API without a subscription, it holds a key.
    expect(claudeSignIn({ ...status, apiProvider: 'firstParty', subscriptionType: null })).toEqual({
      state: 'signed-in',
      method: 'key',
    });
    expect(claudeSignIn({ loggedIn: false, authMethod: 'none' })).toEqual({ state: 'signed-out' });
    expect(claudeSignIn({ authMethod: 'none' })).toEqual({ state: 'unknown' });
  });

  it('takes the plan’s windows from the experimental call, in percent with ISO reset times', () => {
    const resets = '2026-11-04T15:00:00Z';
    expect(
      experimentalWindows(
        usage({
          five_hour: { utilization: 62, resets_at: resets },
          seven_day: { utilization: null, resets_at: null },
          seven_day_opus: null,
          seven_day_sonnet: { utilization: 3, resets_at: resets },
          model_scoped: [{ display_name: 'Fable', utilization: 120, resets_at: 'soon' }],
        }),
      ),
    ).toEqual([
      { span: 'five-hour', used: 62, resetsAt: Date.parse(resets) },
      { span: 'week', used: null, resetsAt: null },
      { span: 'week', model: 'Sonnet', used: 3, resetsAt: Date.parse(resets) },
      { span: 'week', model: 'Fable', used: 100, resetsAt: null },
    ]);
    // Without windows, as when the endpoint refuses the sign-in, the usage stays unread.
    expect(experimentalWindows(usage(null))).toBeUndefined();
    expect(experimentalWindows(usage({}, false))).toBeUndefined();
  });

  it('takes a window from a rate-limit event, whose use is a fraction and whose reset is in seconds', () => {
    expect(
      eventWindows({
        status: 'allowed_warning',
        rateLimitType: 'seven_day_opus',
        utilization: 0.81,
        resetsAt: 1_800_000_000,
      }),
    ).toEqual([{ span: 'week', model: 'Opus', used: 81, resetsAt: 1_800_000_000_000 }]);
    expect(eventWindows({ status: 'rejected', rateLimitType: 'five_hour' })).toEqual([
      { span: 'five-hour', used: 100, resetsAt: null },
    ]);
    expect(eventWindows({ status: 'allowed', rateLimitType: 'overage', utilization: 0.1 })).toEqual(
      [],
    );
    expect(eventWindows({ status: 'allowed' })).toEqual([]);
  });
});
