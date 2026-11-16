interface Waiter {
  keys: readonly string[];
  signal: AbortSignal;
  start: (release: () => void) => void;
  cancel: () => void;
}

// A cancelled caller does not release a running lease. Only backend settlement does that.
export class Scheduler {
  private readonly held = new Set<string>();
  private readonly waiting: Waiter[] = [];
  acquire(keys: readonly string[], signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted || this.waiting.length >= 128) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        keys: [...new Set(keys)].sort(),
        signal,
        start: resolve,
        cancel: () => {
          const i = this.waiting.indexOf(waiter);
          if (i < 0) return;
          this.waiting.splice(i, 1);
          signal.removeEventListener('abort', waiter.cancel);
          resolve(null);
          this.drain();
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
      this.drain();
    });
  }
  private drain(): void {
    const earlier = new Set<string>();
    for (const waiter of [...this.waiting]) {
      if (waiter.keys.some((key) => this.held.has(key) || earlier.has(key))) {
        for (const key of waiter.keys) earlier.add(key);
        continue;
      }
      this.waiting.splice(this.waiting.indexOf(waiter), 1);
      waiter.signal.removeEventListener('abort', waiter.cancel);
      for (const key of waiter.keys) this.held.add(key);
      let released = false;
      waiter.start(() => {
        if (released) return;
        released = true;
        for (const key of waiter.keys) this.held.delete(key);
        this.drain();
      });
    }
  }
}
