import { useEffect, useRef, useState } from 'react';
import type { BrowserTabRef, BrowserTabState } from '../shared/browser';
import type { BrowserBridge } from '../shared/view';

// A tab a browser panel shows: its reference once main resolves it, and its state, the first of it
// as soon as main answers, null once the tab has ended or main does not know it.
export interface ShownTab {
  ref: BrowserTabRef | null;
  state: BrowserTabState | null | undefined;
}

// The key of a tab the window shows, by the session that owns it and its id.
export function tabKey(owner: string, tabId: string): string {
  return `${owner}\n${tabId}`;
}

const NOT_YET: ShownTab = { ref: null, state: undefined };

// The tabs the window's browser panels show, each followed from the first time a panel shows it until
// none does.
export function useBrowserTabs(
  port: Pick<BrowserBridge, 'tabRef' | 'subscribe'>,
  wanted: readonly { owner: string; tabId: string }[],
): (owner: string, tabId: string) => ShownTab {
  const [tabs, setTabs] = useState<ReadonlyMap<string, ShownTab>>(new Map());
  const feeds = useRef(new Map<string, () => void>());
  const key = [...new Set(wanted.map(({ owner, tabId }) => tabKey(owner, tabId)))]
    .sort()
    .join('\0');
  useEffect(() => {
    const keys = new Set(key === '' ? [] : key.split('\0'));
    for (const [shown, stop] of feeds.current) {
      if (keys.has(shown)) continue;
      stop();
      feeds.current.delete(shown);
      setTabs((before) => {
        const after = new Map(before);
        after.delete(shown);
        return after;
      });
    }
    for (const shown of keys) {
      if (feeds.current.has(shown)) continue;
      const [owner = '', tabId = ''] = shown.split('\n');
      feeds.current.set(
        shown,
        follow(port, owner, tabId, (tab) => {
          setTabs((before) => new Map(before).set(shown, tab));
        }),
      );
    }
  }, [port, key]);
  useEffect(() => {
    const running = feeds.current;
    return () => {
      for (const stop of running.values()) stop();
      running.clear();
    };
  }, [port]);
  return (owner, tabId) => tabs.get(tabKey(owner, tabId)) ?? NOT_YET;
}

// Resolves a tab and follows its state until the function returned is called.
function follow(
  port: Pick<BrowserBridge, 'tabRef' | 'subscribe'>,
  owner: string,
  tabId: string,
  changed: (tab: ShownTab) => void,
): () => void {
  let current = true;
  let stop: (() => void) | undefined;
  port.tabRef(owner, tabId).then(
    (ref) => {
      if (!current) return;
      if (ref === null) {
        changed({ ref: null, state: null });
        return;
      }
      stop = port.subscribe(owner, ref, (state) => {
        if (current) changed({ ref, state });
      });
    },
    (error: unknown) => {
      console.error('The tab could not be found:', error);
      if (current) changed({ ref: null, state: null });
    },
  );
  return () => {
    current = false;
    stop?.();
  };
}
