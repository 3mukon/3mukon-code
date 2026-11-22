import type { Outcome } from '../../sessions/shared/automation';
import type { BrowserTabCommand, BrowserTabRef, BrowserTabState, BrowserTabs } from './browser';

// For panel tests. Keep ownership and generation checks identical to the tab contract.
export class FakeBrowserTabs implements BrowserTabs {
  private state: BrowserTabState | null = null;
  private readonly listeners = new Set<() => void>();
  readonly commands: BrowserTabCommand[] = [];
  outcome: Outcome<null> = { status: 'verified', value: null };

  show(state: BrowserTabState | null): void {
    this.state = structuredClone(state);
    for (const listener of [...this.listeners]) listener();
  }

  private find(owner: string, tab: BrowserTabRef): BrowserTabState | null {
    const state = this.state;
    return state?.owner === owner &&
      state.ref.id === tab.id &&
      state.ref.generation === tab.generation
      ? structuredClone(state)
      : null;
  }

  snapshot(owner: string, tab: BrowserTabRef): Promise<BrowserTabState | null> {
    return Promise.resolve(this.find(owner, tab));
  }

  subscribe(owner: string, tab: BrowserTabRef, listener: (state: BrowserTabState | null) => void) {
    const publish = () => {
      listener(this.find(owner, tab));
    };
    this.listeners.add(publish);
    publish();
    return () => {
      this.listeners.delete(publish);
    };
  }

  command(owner: string, tab: BrowserTabRef, command: BrowserTabCommand): Promise<Outcome<null>> {
    if (!this.find(owner, tab))
      return Promise.resolve({ status: 'refused', code: 'stale-target', dispatched: false });
    this.commands.push(structuredClone(command));
    return Promise.resolve(structuredClone(this.outcome));
  }
}
