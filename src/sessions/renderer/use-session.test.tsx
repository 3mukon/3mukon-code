import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { initialSessionState } from '../shared/session-state';
import type { SessionEventsListener, SessionSnapshot, SessionsBridge } from '../shared/sessions';
import { useSession } from './use-session';

afterEach(cleanup);

// The parts of the bridge the hook uses, with the snapshot answered when the test says.
function fakeBridge() {
  const listeners = new Set<SessionEventsListener>();
  let answer: (snapshot: SessionSnapshot | null) => void = () => undefined;
  const bridge = {
    snapshot: () =>
      new Promise<SessionSnapshot | null>((resolve) => {
        answer = resolve;
      }),
    onEvent: (listener: SessionEventsListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as SessionsBridge;
  const emit: SessionEventsListener = (id, seq, event) => {
    act(() => {
      for (const listener of listeners) listener(id, seq, event);
    });
  };
  const snapshot = async (value: SessionSnapshot | null) => {
    await act(async () => {
      answer(value);
      await Promise.resolve();
    });
  };
  return { bridge, emit, snapshot, listeners };
}

describe('useSession', () => {
  it('folds the events after the snapshot, keeping those that came first and skipping those it holds', async () => {
    const { bridge, emit, snapshot } = fakeBridge();
    const { result } = renderHook(() => useSession(bridge, 's1'));
    expect(result.current).toBeNull();
    emit('s1', 2, { type: 'turn-started' });
    emit('s1', 3, { type: 'title', title: 'Fix' });
    emit('other', 4, { type: 'title', title: 'Elsewhere' });
    // The snapshot already holds the first two events.
    await snapshot({ seq: 2, state: { ...initialSessionState(), turnRunning: true } });
    expect(result.current).toMatchObject({ turnRunning: true, title: 'Fix' });
    emit('s1', 3, { type: 'title', title: 'Again' });
    emit('s1', 4, { type: 'turn-ended', outcome: 'completed' });
    expect(result.current).toMatchObject({ turnRunning: false, title: 'Fix' });
  });

  it('follows no session without an id, and stops listening when it goes away', async () => {
    const { bridge, snapshot, listeners } = fakeBridge();
    const { result, unmount, rerender } = renderHook(({ id }) => useSession(bridge, id), {
      initialProps: { id: null as string | null },
    });
    expect(result.current).toBeNull();
    expect(listeners.size).toBe(0);
    rerender({ id: 's1' });
    await snapshot(null);
    expect(result.current).toBeNull();
    unmount();
    expect(listeners.size).toBe(0);
  });
});
