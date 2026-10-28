import { useEffect, useState } from 'react';
import type { WorkspaceList, WorkspacesBridge } from '../shared/workspaces';

const NONE: WorkspaceList = { workspaces: [], selectedId: null };

// The workspace list as the main process keeps it, kept current. Until the first answer arrives it is
// empty.
export function useWorkspaces(bridge: WorkspacesBridge): WorkspaceList {
  const [list, setList] = useState(NONE);
  useEffect(() => {
    let active = true;
    // A change that arrives before the first answer is newer than it.
    let changed = false;
    const stop = bridge.onChange((next) => {
      changed = true;
      setList(next);
    });
    bridge.get().then(
      (first) => {
        if (active && !changed) setList(first);
      },
      (error: unknown) => {
        console.error('The workspace list could not be read:', error);
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);
  return list;
}
