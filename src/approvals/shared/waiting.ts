import type { SessionSummary } from '../../sessions/shared/sessions';

// The sessions waiting on the user for an approval or an answer: how many, and the one that has
// waited longest, by its oldest open request.
export function waitingSessions(sessions: readonly SessionSummary[]): {
  count: number;
  longest?: SessionSummary;
} {
  const waiting = sessions.filter((session) => session.status === 'waiting');
  const since = (session: SessionSummary) => session.waitingSince ?? Number.POSITIVE_INFINITY;
  const longest = waiting.reduce<SessionSummary | undefined>(
    (best, session) => (best === undefined || since(session) < since(best) ? session : best),
    undefined,
  );
  return { count: waiting.length, ...(longest === undefined ? {} : { longest }) };
}

// The waiting session to show next: the one after the given session in the order they have waited,
// coming round again after the last, or the one that has waited longest when the given session is
// not waiting.
export function nextWaiting(
  sessions: readonly SessionSummary[],
  currentId?: string,
): SessionSummary | undefined {
  const since = (session: SessionSummary) => session.waitingSince ?? Number.POSITIVE_INFINITY;
  const waiting = sessions
    .filter((session) => session.status === 'waiting')
    .sort((a, b) => (since(a) < since(b) ? -1 : since(a) > since(b) ? 1 : 0));
  if (waiting.length === 0) return undefined;
  const at = waiting.findIndex((session) => session.id === currentId);
  return waiting[(at + 1) % waiting.length];
}
