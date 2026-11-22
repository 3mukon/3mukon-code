import { useEffect, useState } from 'react';
import type { SetupSnapshot } from '../../sessions/shared/automation';
import type { UserSetupBridge } from '../../toolset/shared/automation';

// Browser and computer use's setup as main reports it, while the window wants it, as while its
// settings show: read once wanted, and again as the window regains the focus, as it does after the
// user allows a permission in System Settings. A newer event or request supersedes a pending read.
export function useUserSetup(bridge: UserSetupBridge, wanted: boolean): SetupSnapshot | null {
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    let revision = 0;
    const take = (next: SetupSnapshot) => {
      if (current) setSnapshot(next);
    };
    const read = () => {
      const reading = ++revision;
      bridge.snapshot().then(
        (next) => {
          if (reading === revision) take(next);
        },
        (error: unknown) => {
          console.error('The setup of browser and computer use could not be read:', error);
        },
      );
    };
    const stop = bridge.subscribe((next) => {
      revision++;
      take(next);
    });
    read();
    window.addEventListener('focus', read);
    return () => {
      current = false;
      stop();
      window.removeEventListener('focus', read);
    };
  }, [bridge, wanted]);
  return snapshot;
}
