import { describe, expect, it } from 'vitest';
import { completedTurn, parseSessionNotice, retryOf } from './turns';

const notice = (update: Record<string, unknown>) =>
  parseSessionNotice({ sessionId: 'grok-1', update });

describe('retryOf', () => {
  it('reads the retry Grok makes, of how many at most, and why', () => {
    expect(
      retryOf(
        notice({
          sessionUpdate: 'retry_state',
          type: 'retrying',
          attempt: 3,
          max_retries: 15,
          reason: 'API error (status 500 Internal Server Error): Service temporarily unavailable',
          is_rate_limited: false,
        }),
      ),
    ).toEqual({
      type: 'retrying',
      attempt: 3,
      maxRetries: 15,
      reason: 'API error (status 500 Internal Server Error): Service temporarily unavailable',
    });
  });

  it('keeps a retry whose fields it cannot read, without them', () => {
    expect(
      retryOf(
        notice({
          sessionUpdate: 'retry_state',
          type: 'retrying',
          attempt: '3',
          max_retries: null,
          reason: 42,
        }),
      ),
    ).toEqual({ type: 'retrying' });
  });

  it('reads nothing from Grok giving up, or from its other notices', () => {
    expect(
      retryOf(
        notice({
          sessionUpdate: 'retry_state',
          type: 'exhausted',
          attempt: 15,
          max_retries: 15,
          reason: 'API error',
        }),
      ),
    ).toBeUndefined();
    expect(
      retryOf(notice({ sessionUpdate: 'retry_state', type: 'failed', reason: 'API error' })),
    ).toBeUndefined();
    const completed = notice({
      sessionUpdate: 'turn_completed',
      prompt_id: 'p1',
      stop_reason: 'end_turn',
    });
    expect(retryOf(completed)).toBeUndefined();
    expect(completedTurn(completed)).toEqual({ promptId: 'p1', stopReason: 'end_turn' });
  });
});
