import type { SessionHost } from '../../sessions/main/host';
import type { AutomationEvent, Envelope, Outcome } from '../../sessions/shared/automation';
import type { AutomationBroker } from '../../toolset/main/broker';
import type { AutomationBridge } from '../../toolset/shared/automation';

const missing = (): Outcome<never> => ({ status: 'refused', code: 'not-found', dispatched: false });
const read = <T>(value: () => T): Promise<T> => Promise.resolve().then(value);

// App-only user actions and reads. MCP tools receive neither this port nor its subscription IDs.
export function automationUi(
  broker: AutomationBroker | undefined,
  sessions: Pick<SessionHost, 'has' | 'interrupt'>,
): AutomationBridge {
  const known = (id: string) => {
    if (!sessions.has(id)) throw new Error('The app has no such session.');
  };
  const active = (id: string) => {
    known(id);
    if (!broker?.hasOwner(id)) throw new Error('Automation is not available for this session.');
    return broker;
  };
  const available = (id: string) => sessions.has(id) && broker?.hasOwner(id);
  return {
    snapshot: (id) => read(() => active(id).snapshot(id)),
    capabilities: (id) => read(() => active(id).capabilities(id)),
    subscribe(id, listener) {
      known(id);
      return (
        broker?.subscribe(id, (event) => {
          if (sessions.has(id)) listener(event);
        }) ?? (() => undefined)
      );
    },
    callRecord: (id, callId) =>
      read(() => {
        const value = available(id) ? active(id).record(id, callId) : undefined;
        return value ? { status: 'verified', value } : missing();
      }),
    callFrames: (id, callId) =>
      read(() => (available(id) ? active(id).frames(id, callId) : missing())),
    icon: (id, iconId) => read(() => (available(id) ? active(id).icon(id, iconId) : missing())),
    answer: (id, requestId, answer) =>
      read(() => (available(id) ? active(id).answer(id, requestId, answer) : missing())),
    endOperation: (id, operationId) =>
      read(() => (available(id) ? active(id).endOperation(id, operationId) : missing())),
    endGrant: (id, grantId) =>
      read(() => (available(id) ? active(id).endGrant(id, grantId) : missing())),
    async stop(id) {
      if (!available(id)) return missing();
      active(id).stop(id);
      try {
        await sessions.interrupt(id);
        return { status: 'verified', value: null };
      } catch {
        return { status: 'indeterminate', reason: 'backend-lost', exclusionHeld: false };
      }
    },
  };
}

// One page owns its listeners. Reload, renderer loss, destruction and unsubscribe all release them;
// an unsubscribe from another window cannot end this page's listener.
export class AutomationSubscriptions {
  private readonly pages = new Map<number, Map<string, { session: string; stop(): void }>>();
  constructor(private readonly bridge: AutomationBridge) {}
  add(
    page: number,
    id: string,
    session: string,
    listener: (event: Envelope<AutomationEvent>) => void,
  ): void {
    const entries = this.pages.get(page) ?? new Map<string, { session: string; stop(): void }>();
    const existing = entries.get(id);
    if (existing) {
      if (existing.session !== session) throw new Error('Subscription identity conflict.');
      return;
    }
    if (entries.size >= 128) throw new Error('Too many automation subscriptions.');
    const stop = this.bridge.subscribe(session, listener);
    entries.set(id, { session, stop });
    this.pages.set(page, entries);
  }
  remove(page: number, id: string): void {
    const entries = this.pages.get(page);
    entries?.get(id)?.stop();
    entries?.delete(id);
    if (!entries?.size) this.pages.delete(page);
  }
  release(page: number): void {
    for (const entry of this.pages.get(page)?.values() ?? []) entry.stop();
    this.pages.delete(page);
  }
}
