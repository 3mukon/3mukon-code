import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../sessions/shared/sessions';
import { nextWaiting, waitingSessions } from './waiting';

const session = (id: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  provider: 'codex',
  sessionId: `p-${id}`,
  cwd: '/Users/me/web',
  status: 'idle',
  openedAt: 0,
  ...fields,
});

describe('waitingSessions', () => {
  it('counts the sessions waiting on the user and finds the one that has waited longest', () => {
    const waiting = waitingSessions([
      session('s1', { status: 'waiting', waitingSince: 300 }),
      session('s2', { status: 'running' }),
      session('s3', { status: 'waiting', waitingSince: 100 }),
      session('s4', { status: 'waiting' }),
    ]);
    expect(waiting.count).toBe(3);
    expect(waiting.longest?.id).toBe('s3');
    expect(waitingSessions([session('s1')])).toEqual({ count: 0 });
  });

  it('goes round the waiting sessions in the order they have waited, from the one waiting longest', () => {
    const sessions = [
      session('s1', { status: 'waiting', waitingSince: 300 }),
      session('s2', { status: 'idle' }),
      session('s3', { status: 'waiting', waitingSince: 100 }),
      session('s4', { status: 'waiting' }),
    ];
    expect(nextWaiting(sessions)?.id).toBe('s3');
    expect(nextWaiting(sessions, 's2')?.id).toBe('s3');
    expect(nextWaiting(sessions, 's3')?.id).toBe('s1');
    expect(nextWaiting(sessions, 's1')?.id).toBe('s4');
    expect(nextWaiting(sessions, 's4')?.id).toBe('s3');
    expect(nextWaiting([session('s2')])).toBeUndefined();
  });
});
