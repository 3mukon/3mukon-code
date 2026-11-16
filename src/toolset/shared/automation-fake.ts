import type {
  AutomationCallRecord,
  AutomationCapabilities,
  AutomationEvent,
  AutomationSnapshot,
  Envelope,
  Frame,
  Outcome,
  SetupSnapshot,
} from '../../sessions/shared/automation';
import type { ApprovalAnswer, MessageImage } from '../../sessions/shared/events';
import { AUTOMATION_RESULT_LIMITS } from '../../sessions/shared/automation';
import {
  foldAutomationEvent,
  liveAutomationState,
  referencedIconIds,
} from '../../sessions/shared/automation-state';
import type { AutomationBridge, SetupAction, UserSetupBridge } from './automation';

// Controllable UI fixture, deliberately not an authorization engine. Tests drive facts explicitly;
// commands are recorded and return the configured outcome without running a backend.
export class FakeAutomationBridge implements AutomationBridge {
  readonly commands: { kind: string; sessionId: string; id?: string; answer?: ApprovalAnswer }[] =
    [];
  outcome: Outcome<null> = { status: 'verified', value: null };
  private readonly snapshots = new Map<string, Envelope<AutomationSnapshot>>();
  private readonly toolCapabilities = new Map<string, AutomationCapabilities>();
  private readonly frames = new Map<string, Map<string, readonly Frame[]>>();
  private readonly icons = new Map<string, MessageImage>();
  private readonly listeners = new Map<string, Set<(event: Envelope<AutomationEvent>) => void>>();
  seed(
    snapshot: AutomationSnapshot,
    epoch = 'fixture',
    sequence = 0,
    capabilities?: AutomationCapabilities,
  ): void {
    this.snapshots.set(
      snapshot.sessionId,
      structuredClone({ epoch, sequence, sessionId: snapshot.sessionId, value: snapshot }),
    );
    this.frames.delete(snapshot.sessionId);
    this.toolCapabilities.set(
      snapshot.sessionId,
      structuredClone(
        capabilities ?? {
          policy: snapshot.policy,
          tools: [],
          resultLimits: { ...AUTOMATION_RESULT_LIMITS },
        },
      ),
    );
  }
  // Advance the source sequence without delivering an event, to exercise resnapshotting.
  skipSequence(sessionId: string, count = 1): void {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot || !Number.isSafeInteger(count) || count < 1)
      throw new Error('Invalid fixture gap.');
    snapshot.sequence += count;
  }
  seedFrames(sessionId: string, callId: string, frames: readonly Frame[]): void {
    let calls = this.frames.get(sessionId);
    if (!calls) {
      calls = new Map();
      this.frames.set(sessionId, calls);
    }
    calls.set(callId, structuredClone(frames));
  }
  seedIcon(id: string, image: MessageImage): void {
    this.icons.set(id, structuredClone(image));
  }
  icon(sessionId: string, iconId: string): Promise<Outcome<MessageImage>> {
    const snapshot = this.snapshots.get(sessionId);
    const image = this.icons.get(iconId);
    return Promise.resolve(
      snapshot && image && referencedIconIds(snapshot.value).has(iconId)
        ? { status: 'verified', value: { ...image } }
        : { status: 'refused', code: 'not-found', dispatched: false },
    );
  }
  publish(sessionId: string, event: AutomationEvent): void {
    const before = this.snapshots.get(sessionId);
    if (!before) throw new Error('Seed the fixture session first.');
    const envelope = {
      epoch: before.epoch,
      sequence: before.sequence + 1,
      sessionId,
      value: structuredClone(
        event.kind === 'state'
          ? { kind: 'state' as const, state: liveAutomationState(event.state) }
          : event,
      ),
    };
    const after = foldAutomationEvent(before, envelope);
    if (!after) throw new Error('Invalid fixture event.');
    this.snapshots.set(sessionId, after);
    const images = this.frames.get(sessionId);
    if (images) {
      for (const callId of images.keys()) {
        const record = after.value.recentCalls.find((call) => call.callId === callId);
        if (!record || record.framesState === 'evicted') images.delete(callId);
      }
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener(structuredClone(envelope));
  }
  snapshot(sessionId: string): Promise<Envelope<AutomationSnapshot>> {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot
      ? Promise.resolve(structuredClone(snapshot))
      : Promise.reject(new Error('Unknown fixture session.'));
  }
  subscribe(sessionId: string, listener: (event: Envelope<AutomationEvent>) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
  callRecord(sessionId: string, callId: string): Promise<Outcome<AutomationCallRecord>> {
    const record = this.snapshots
      .get(sessionId)
      ?.value.recentCalls.find((r) => r.callId === callId);
    return Promise.resolve(
      record
        ? { status: 'verified', value: structuredClone(record) }
        : { status: 'refused', code: 'not-found', dispatched: false },
    );
  }
  capabilities(sessionId: string): Promise<AutomationCapabilities> {
    const value = this.toolCapabilities.get(sessionId);
    const snapshot = this.snapshots.get(sessionId);
    if (!value || !snapshot) return Promise.reject(new Error('Unknown fixture session.'));
    return Promise.resolve(structuredClone({ ...value, policy: snapshot.value.policy }));
  }
  async callFrames(sessionId: string, callId: string): Promise<Outcome<readonly Frame[]>> {
    const record = await this.callRecord(sessionId, callId);
    if (record.status !== 'verified')
      return { status: 'refused', code: 'not-found', dispatched: false };
    const frames = this.frames.get(sessionId)?.get(callId);
    if (record.value.framesState === 'evicted' || (!frames && record.value.frames.length))
      return { status: 'refused', code: 'result-expired', dispatched: false };
    return { status: 'verified', value: structuredClone(frames ?? []) };
  }
  answer(sessionId: string, id: string, answer: ApprovalAnswer): Promise<Outcome<null>> {
    this.commands.push({ kind: 'answer', sessionId, id, answer: structuredClone(answer) });
    return Promise.resolve(structuredClone(this.outcome));
  }
  stop(sessionId: string): Promise<Outcome<null>> {
    return this.command('stop', sessionId);
  }
  endOperation(sessionId: string, id: string): Promise<Outcome<null>> {
    return this.command('end-operation', sessionId, id);
  }
  endGrant(sessionId: string, id: string): Promise<Outcome<null>> {
    return this.command('end-grant', sessionId, id);
  }
  private command(kind: string, sessionId: string, id?: string): Promise<Outcome<null>> {
    this.commands.push({ kind, sessionId, ...(id ? { id } : {}) });
    return Promise.resolve(structuredClone(this.outcome));
  }
}

export class FakeUserSetupBridge implements UserSetupBridge {
  readonly commands: SetupAction[] = [];
  outcome: Outcome<null> = { status: 'refused', code: 'setup-required', dispatched: false };
  private readonly listeners = new Set<(snapshot: SetupSnapshot) => void>();
  private current: SetupSnapshot;
  constructor(snapshot: SetupSnapshot) {
    this.current = structuredClone(snapshot);
  }
  snapshot(): Promise<SetupSnapshot> {
    return Promise.resolve(structuredClone(this.current));
  }
  publish(snapshot: SetupSnapshot): void {
    this.current = structuredClone(snapshot);
    for (const listener of this.listeners) listener(structuredClone(snapshot));
  }
  subscribe(listener: (snapshot: SetupSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  act(action: SetupAction): Promise<Outcome<null>> {
    this.commands.push(structuredClone(action));
    return Promise.resolve(structuredClone(this.outcome));
  }
}
