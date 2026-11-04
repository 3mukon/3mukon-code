import { describe, expect, it } from 'vitest';
import { mostUsed, problemOf, type UsageWindow } from './accounts';

const window = (used: number | null): UsageWindow => ({ span: 'week', used, resetsAt: null });

describe('the accounts’ contract', () => {
  it('finds the window most used from 80%, and none below it or without a share', () => {
    expect(mostUsed({ windows: [window(79), window(null)], readAt: 0 })).toBeUndefined();
    expect(mostUsed({ windows: [window(85), window(100), window(null)], readAt: 0 })).toEqual(
      window(100),
    );
    expect(mostUsed(undefined)).toBeUndefined();
  });

  it('reads a failed request as the sign-in refused when it speaks of access, and as the provider unreachable otherwise', () => {
    expect(problemOf(new Error('unexpected status 401 Unauthorized'))).toBe('refused');
    expect(problemOf(new Error('Authentication required to fetch billing data'))).toBe('refused');
    expect(problemOf('403 Forbidden')).toBe('refused');
    expect(problemOf(new Error('Codex did not start in time.'))).toBe('unreachable');
  });
});
