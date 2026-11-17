import { useEffect, useRef, useState } from 'react';
import type {
  AutomationEvent,
  AutomationSnapshot,
  Envelope,
} from '../../sessions/shared/automation';
import { foldAutomationEvent } from '../../sessions/shared/automation-state';
import type { AutomationBridge } from '../../toolset/shared/automation';

// How many events a session's feed keeps while it waits for a snapshot; past them, it reads one anew.
const HEARD = 1024;

// The automation of each session the window shows, as main keeps it: its snapshot, kept current by
// its events, from the first time the session shows until it no longer does. A session main has not
// bound yet has none until its first event, after which the window reads it again.
export function useAutomation(
  bridge: AutomationBridge,
  sessionIds: readonly string[],
): ReadonlyMap<string, AutomationSnapshot> {
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, AutomationSnapshot>>(new Map());
  const feeds = useRef(new Map<string, () => void>());
  const key = [...new Set(sessionIds)].sort().join('\n');
  useEffect(() => {
    const ids = new Set(key === '' ? [] : key.split('\n'));
    for (const [id, stop] of feeds.current) {
      if (ids.has(id)) continue;
      stop();
      feeds.current.delete(id);
    }
    for (const id of ids) {
      if (feeds.current.has(id)) continue;
      feeds.current.set(
        id,
        follow(bridge, id, (snapshot) => {
          setSnapshots((before) => new Map(before).set(id, snapshot));
        }),
      );
    }
  }, [bridge, key]);
  useEffect(() => {
    const running = feeds.current;
    return () => {
      for (const stop of running.values()) stop();
      running.clear();
    };
  }, [bridge]);
  const shown = new Set(key === '' ? [] : key.split('\n'));
  return new Map([...snapshots].filter(([id]) => shown.has(id)));
}

// Follows one session's automation: listens first, then reads its snapshot and applies what it heard
// meanwhile, and reads it again after a gap or a new epoch, or once the next event comes after main
// refused it. The function returned stops it.
export function follow(
  bridge: AutomationBridge,
  sessionId: string,
  changed: (snapshot: AutomationSnapshot) => void,
): () => void {
  let current: Envelope<AutomationSnapshot> | null = null;
  let heard: Envelope<AutomationEvent>[] = [];
  let reading = false;
  let stopped = false;
  const read = () => {
    if (reading || stopped) return;
    reading = true;
    bridge.snapshot(sessionId).then(
      (snapshot) => {
        reading = false;
        if (stopped) return;
        let next: Envelope<AutomationSnapshot> | null = snapshot;
        for (const event of heard) {
          next = foldAutomationEvent(next, event);
          if (next === null) break;
        }
        heard = [];
        if (next === null) {
          read();
          return;
        }
        current = next;
        changed(next.value);
      },
      () => {
        // Not bound yet, or gone: the next event reads it again.
        reading = false;
      },
    );
  };
  const stopListening = bridge.subscribe(sessionId, (event) => {
    if (stopped) return;
    const next = current === null ? null : foldAutomationEvent(current, event);
    if (next === null) {
      current = null;
      heard = [...heard, event].slice(-HEARD);
      read();
      return;
    }
    if (next === current) return;
    current = next;
    changed(next.value);
  });
  read();
  return () => {
    stopped = true;
    stopListening();
  };
}
