import { useEffect, useState } from 'react';
import type { SessionEvent } from '../shared/events';
import { applyEvent, type SessionState } from '../shared/session-state';
import type { SessionsBridge, SessionSnapshot } from '../shared/sessions';

// A session's state, kept current through the bridge: the main process's snapshot, then each event as
// it happens, folded the same way. Events that arrive before the snapshot wait for it, and those it
// already holds are skipped by their numbers. Null until the snapshot arrives, and for no session.
export function useSession(bridge: SessionsBridge, id: string | null): SessionState | null {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);

  useEffect(() => {
    if (id === null) return;
    let current: SessionSnapshot | null = null;
    const early: [number, SessionEvent][] = [];
    let live = true;
    const fold = (from: SessionSnapshot, seq: number, event: SessionEvent): SessionSnapshot =>
      seq <= from.seq ? from : { seq, state: applyEvent(from.state, event) };
    const stop = bridge.onEvent((session, seq, event) => {
      if (session !== id) return;
      if (current === null) {
        early.push([seq, event]);
        return;
      }
      current = fold(current, seq, event);
      setSnapshot(current);
    });
    bridge.snapshot(id).then(
      (found) => {
        if (!live || found === null) return;
        current = early.reduce((from, [seq, event]) => fold(from, seq, event), found);
        setSnapshot(current);
      },
      (error: unknown) => {
        console.error('The session could not be shown:', error);
      },
    );
    return () => {
      live = false;
      stop();
      setSnapshot(null);
    };
  }, [bridge, id]);

  return snapshot?.state ?? null;
}
