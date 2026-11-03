import { useEffect, useState } from 'react';
import type { SessionList, SessionsBridge } from '../shared/sessions';

const NONE: SessionList = { sessions: [], archived: 0, shown: [] };

// What the lists show of the sessions as the main process reports it, kept current: the sessions that
// are not archived, the most recently active first, how many are archived, and the others whose pages
// the window has shown. Until the first answer arrives there are none.
export function useSessions(bridge: SessionsBridge): SessionList {
  const [list, setList] = useState(NONE);
  useEffect(() => {
    let active = true;
    // A change that arrives before the first answer is newer than it.
    let changed = false;
    const stop = bridge.onChange((next) => {
      changed = true;
      setList(next);
    });
    bridge.list().then(
      (first) => {
        if (active && !changed) setList(first);
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
  return list;
}
