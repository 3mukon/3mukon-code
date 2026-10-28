import { useEffect, useState } from 'react';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';

const NONE: SessionSummary[] = [];

// The app's open sessions as the main process reports them, newest first, kept current. Until the
// first answer arrives there are none.
export function useSessions(bridge: SessionsBridge): SessionSummary[] {
  const [sessions, setSessions] = useState(NONE);
  useEffect(() => {
    let active = true;
    // A change that arrives before the first answer is newer than it.
    let changed = false;
    const stop = bridge.onChange((next) => {
      changed = true;
      setSessions(next);
    });
    bridge.list().then(
      (first) => {
        if (active && !changed) setSessions(first);
      },
      (error: unknown) => {
        console.error('The sessions could not be listed:', error);
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);
  return sessions;
}
