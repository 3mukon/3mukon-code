import { createHash, randomUUID } from 'node:crypto';
import type {
  ActivityIncident,
  AutomationCallRecord,
  AutomationEvent,
  Frame,
  GrantEndRecord,
  HostApproval,
  OperationEnd,
  Outcome,
  PresentationNotice,
  PresentationSummary,
  ProviderToolLink,
  TargetSummary,
  ToolsetResult,
} from '../../sessions/shared/automation';
import type { ApprovalAnswer } from '../../sessions/shared/events';
import { AUTOMATION_ACTIVITY_LIMITS } from '../../sessions/shared/automation';
import { isJson, requestKey } from './execution';
import { referencedIconIds } from '../../sessions/shared/automation-state';

const IMAGE_BUDGET = 16 * 1024 * 1024;
const refused = (
  code:
    | 'not-found'
    | 'wrong-owner'
    | 'request-conflict'
    | 'limit-exceeded'
    | 'invalid-request'
    | 'result-expired',
): Outcome<never> => ({ status: 'refused', code, dispatched: false });
interface NoticeDelivery {
  id: string;
  version: number;
}

// Bounded session-owned activity. Provider adapters pass already-normalized receipts; this class
// never parses model prose or a page's content to find a call ID.
export class Activity {
  private readonly records = new Map<string, AutomationCallRecord>();
  private readonly images = new Map<string, readonly Frame[]>();
  private readonly notices = new Map<string, PresentationNotice>();
  // Keep recent version receipts after delivery; pending presentations are never pruned.
  private readonly versions = new Map<
    string,
    { version: number; hash: string; reuseKey: string }
  >();
  private readonly deliveries = new Map<string, readonly NoticeDelivery[]>();
  private readonly turns = new Map<string, readonly NoticeDelivery[]>();
  constructor(
    private readonly owner: string,
    private readonly emit: (event: AutomationEvent) => void,
    private readonly now: () => number,
  ) {}

  start(
    generation: number,
    turn: string | null,
    tool: string,
    family: 'browser' | 'computer' | 'panel',
  ): AutomationCallRecord {
    this.trim();
    const base = {
      callId: randomUUID(),
      sessionId: this.owner,
      turnId: turn,
      accessGeneration: generation,
      revision: 1,
      toolName: tool,
      operationId: null,
      operationEnd: null,
      grantId: null,
      grantEnd: null,
      approval: null,
      incidents: [],
      startedAt: this.now(),
      completedAt: null,
      phase: 'received' as const,
      outcome: null,
      frames: [],
      framesState: 'available' as const,
      providerEntry: null,
    };
    const record: AutomationCallRecord =
      family === 'panel'
        ? { ...base, family, presentations: [] }
        : {
            ...base,
            family,
            target: { state: 'unresolved' },
            sharing: null,
            delivery: 'background',
          };
    this.records.set(record.callId, record);
    this.publish(record);
    return record;
  }
  list(): AutomationCallRecord[] {
    return structuredClone([...this.records.values()]);
  }
  get(id: string): AutomationCallRecord | undefined {
    const record = this.records.get(id);
    return record && structuredClone(record);
  }
  iconIds(): Set<string> {
    return referencedIconIds({ recentCalls: this.records.values() });
  }
  frames(id: string): Outcome<readonly Frame[]> {
    const record = this.records.get(id);
    if (!record) return refused('not-found');
    if (record.framesState === 'evicted') return refused('result-expired');
    return { status: 'verified', value: structuredClone(this.images.get(id) ?? []) };
  }
  target(id: string, target: TargetSummary, delivery: 'background' | 'foreground'): void {
    const record = this.records.get(id);
    if (!record || record.family === 'panel') return;
    record.target = { state: 'resolved', summary: structuredClone(target) };
    record.sharing = target.sharing ?? null;
    record.delivery = delivery;
    this.publish(record);
  }
  phase(
    id: string,
    phase: AutomationCallRecord['phase'],
    operationId: string | null,
    grantId: string | null = null,
  ): void {
    const record = this.records.get(id);
    if (!record) return;
    record.phase = phase;
    record.operationId = operationId;
    record.grantId = grantId;
    this.publish(record);
  }
  approvalRequested(request: HostApproval): void {
    const record = this.records.get(request.callId);
    if (!record) return;
    record.operationId = request.operation.id;
    record.approval = {
      request: structuredClone(request),
      answer: null,
      answeredAt: null,
      grantId: null,
    };
    this.publish(record);
  }
  approvalAnswered(id: string, answer: ApprovalAnswer, at: number, grantId: string | null): void {
    for (const record of this.records.values()) {
      if (record.approval?.request.id !== id) continue;
      record.approval.answer = structuredClone(answer);
      record.approval.answeredAt = at;
      record.approval.grantId = grantId;
      record.grantId = grantId;
      this.publish(record);
    }
  }
  operationEnded(id: string, end: OperationEnd): void {
    for (const record of this.records.values()) {
      if (record.operationId !== id) continue;
      record.operationEnd = { ...end };
      this.publish(record);
    }
  }
  grantEnded(end: GrantEndRecord): void {
    for (const record of this.records.values()) {
      if (record.grantId !== end.grant.id) continue;
      record.grantEnd = structuredClone(end);
      this.publish(record);
    }
  }
  incident(id: string, event: ActivityIncident): Outcome<null> {
    const record = this.records.get(id);
    if (!record) return refused('not-found');
    if (event.operationId !== record.operationId || !Number.isFinite(event.at) || event.at < 0)
      return refused('invalid-request');
    if (record.incidents.length >= AUTOMATION_ACTIVITY_LIMITS.incidentsPerCall)
      return refused('limit-exceeded');
    record.incidents = [...record.incidents, structuredClone(event)];
    this.publish(record);
    return { status: 'verified', value: null };
  }
  settle(
    id: string,
    outcome: Outcome,
    frames: readonly Frame[] = [],
    presentations: readonly PresentationSummary[] = [],
  ): ToolsetResult {
    const record = this.records.get(id);
    if (!record) throw new Error('The call record is no longer retained.');
    record.outcome = structuredClone(outcome);
    record.frames = frames.map(({ image, ...metadata }) => ({
      ...structuredClone(metadata),
      mediaType: image.mediaType,
    }));
    this.images.set(id, structuredClone(frames));
    record.completedAt = this.now();
    record.phase = 'settled';
    if (record.family === 'panel') record.presentations = structuredClone(presentations);
    this.boundImages();
    this.publish(record);
    return this.result(record);
  }
  settledExclusion(id: string): void {
    const record = this.records.get(id);
    if (record?.outcome?.status !== 'indeterminate' || !record.outcome.exclusionHeld) return;
    record.outcome.exclusionHeld = false;
    this.publish(record);
  }
  pendingNotices(): PresentationNotice[] {
    return structuredClone([...this.notices.values()]);
  }
  presentationChanged(notice: PresentationNotice): Outcome<null> {
    if (notice.owner !== this.owner) return refused('wrong-owner');
    const { id, version } = notice.presentation;
    if (!id || !notice.noticeId || !Number.isSafeInteger(version) || version < 0 || !isJson(notice))
      return refused('invalid-request');
    const before = this.versions.get(id);
    if (before && notice.reuseKey !== before.reuseKey) return refused('request-conflict');
    if (before && version < before.version) return { status: 'verified', value: null };
    const hash = createHash('sha256').update(requestKey(notice)).digest('hex');
    if (before?.version === version && before.hash !== hash) return refused('request-conflict');
    if (before?.version === version) return { status: 'verified', value: null };
    if (!this.notices.has(id) && this.notices.size >= 256) return refused('limit-exceeded');
    this.versions.delete(id);
    this.versions.set(id, { version, hash, reuseKey: notice.reuseKey });
    this.notices.set(id, structuredClone(notice));
    for (const older of this.versions.keys()) {
      if (this.versions.size <= AUTOMATION_ACTIVITY_LIMITS.noticeReceipts) break;
      if (!this.notices.has(older)) this.versions.delete(older);
    }
    this.emit({ kind: 'presentation-notices', notices: this.pendingNotices() });
    return { status: 'verified', value: null };
  }
  prepareTurn(): { id: string; notices: PresentationNotice[] } {
    if (this.turns.size >= 32) throw new Error('Too many sends await provider acceptance.');
    const id = randomUUID();
    const notices = this.pendingNotices();
    this.turns.set(id, notices.map(deliveryOf));
    return { id, notices };
  }
  finishTurnDelivery(id: string, accepted: boolean): void {
    if (accepted) this.retire(this.turns.get(id) ?? []);
    this.turns.delete(id);
  }
  link(link: ProviderToolLink): Outcome<null> {
    if (link.sessionId !== this.owner) return refused('wrong-owner');
    const record = this.records.get(link.callId);
    if (!record) return refused('not-found');
    if (record.phase !== 'settled') return refused('request-conflict');
    if (
      record.turnId !== link.turnId ||
      record.accessGeneration !== link.accessGeneration ||
      record.toolName !== link.toolName
    )
      return refused('request-conflict');
    const key = (v: ProviderToolLink) =>
      JSON.stringify([v.sessionId, v.turnId, v.accessGeneration, v.providerToolId]);
    if (
      (record.providerEntry && key(record.providerEntry) !== key(link)) ||
      [...this.records.values()].some(
        (r) => r.callId !== record.callId && r.providerEntry && key(r.providerEntry) === key(link),
      )
    )
      return refused('request-conflict');
    record.providerEntry = structuredClone(link);
    this.retire(this.deliveries.get(record.callId) ?? []);
    this.deliveries.delete(record.callId);
    this.publish(record);
    return { status: 'verified', value: null };
  }
  private result(record: AutomationCallRecord): ToolsetResult {
    if (!record.outcome) throw new Error('The call has no outcome.');
    const notices = this.pendingNotices();
    this.deliveries.set(record.callId, notices.map(deliveryOf));
    return structuredClone({
      automation: { schemaVersion: 1, callId: record.callId },
      outcome: record.outcome,
      frames: this.images.get(record.callId) ?? [],
      presentationNotices: notices,
    });
  }
  private retire(deliveries: readonly NoticeDelivery[]): void {
    let changed = false;
    for (const { id, version } of deliveries) {
      const pending = this.notices.get(id);
      if (pending && pending.presentation.version <= version) {
        this.notices.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit({ kind: 'presentation-notices', notices: this.pendingNotices() });
  }
  private publish(record: AutomationCallRecord): void {
    record.revision += 1;
    this.emit({ kind: 'tool-call', call: structuredClone(record) });
  }
  private trim(): void {
    while (this.records.size >= AUTOMATION_ACTIVITY_LIMITS.records) {
      const oldest = [...this.records.values()].find((r) => r.phase === 'settled');
      if (!oldest) throw new Error('Too many unsettled calls.');
      this.records.delete(oldest.callId);
      this.deliveries.delete(oldest.callId);
      this.images.delete(oldest.callId);
      this.emit({ kind: 'tool-call-removed', callId: oldest.callId });
    }
  }
  private boundImages(): void {
    let bytes = [...this.images.values()].reduce(
      (sum, frames) => sum + frames.reduce((n, f) => n + f.image.data.length, 0),
      0,
    );
    for (const record of this.records.values()) {
      if (bytes <= IMAGE_BUDGET) break;
      const frames = this.images.get(record.callId) ?? [];
      bytes -= frames.reduce((n, f) => n + f.image.data.length, 0);
      if (frames.length) {
        this.images.delete(record.callId);
        record.framesState = 'evicted';
        this.publish(record);
      }
    }
  }
}

function deliveryOf(notice: PresentationNotice): NoticeDelivery {
  return { id: notice.presentation.id, version: notice.presentation.version };
}
