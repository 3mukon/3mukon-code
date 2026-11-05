import { describe, expect, it } from 'vitest';
import { Probes } from './provider';

// A probe's process that ends when it is stopped, or on its own through end, and counts its stops.
function fakeProbe() {
  let markEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const probe = {
    stops: 0,
    hasEnded: false,
    ended,
    stop() {
      probe.stops++;
      // It takes a moment to end, as a process does.
      setTimeout(markEnded, 10);
      return ended;
    },
    end() {
      markEnded();
    },
  };
  void ended.then(() => {
    probe.hasEnded = true;
  });
  return probe;
}

describe('Probes', () => {
  it('stops the probes still running as it closes and resolves once they have ended', async () => {
    const probes = new Probes();
    const running = await probes.start(() => fakeProbe());
    const done = await probes.start(() => fakeProbe());
    done.end();
    await done.ended;
    await probes.close();
    expect(running.stops).toBe(1);
    expect(running.hasEnded).toBe(true);
    // One that ended on its own is left alone.
    expect(done.stops).toBe(0);
  });

  it('waits for a probe still starting as it closes, stops it, and starts none after', async () => {
    const probes = new Probes();
    const probe = fakeProbe();
    let started: (value: typeof probe) => void = () => undefined;
    const starting = probes.start(
      () =>
        new Promise<typeof probe>((resolve) => {
          started = resolve;
        }),
    );
    const closed = probes.close();
    started(probe);
    await expect(starting).rejects.toThrow('closed');
    await closed;
    expect(probe.stops).toBeGreaterThan(0);
    expect(probe.hasEnded).toBe(true);
    let called = false;
    await expect(
      probes.start(() => {
        called = true;
        return fakeProbe();
      }),
    ).rejects.toThrow('closed');
    expect(called).toBe(false);
  });

  it('closes at once when no probe runs, and forgets a probe whose start failed', async () => {
    const probes = new Probes();
    await expect(probes.start(() => Promise.reject(new Error('no binary')))).rejects.toThrow(
      'no binary',
    );
    await probes.close();
  });
});
