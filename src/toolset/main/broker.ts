import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalAnswer } from '../../sessions/shared/events';
import type {
  ActivityIncident,
  AutomationCapabilities,
  AutomationEvent,
  AutomationLiveState,
  AutomationPolicy,
  AutomationSnapshot,
  EndReason,
  Envelope,
  FailureCode,
  Grant,
  GrantEndRecord,
  HostApproval,
  Operation,
  Outcome,
  PresentationNotice,
  RefusalDetail,
  ProviderToolLink,
  TargetRef,
  TargetSummary,
  ToolsetResult,
} from '../../sessions/shared/automation';
import { Activity } from './activity';
import {
  AUTOMATION_ACTIVITY_LIMITS,
  AUTOMATION_RESULT_LIMITS,
} from '../../sessions/shared/automation';
import {
  validResult,
  DEFAULT_ARGUMENT_BYTES,
  MAX_ARGUMENT_BYTES,
  requestKey,
  type AutomationTool,
  type ExecutionPlan,
  type ExecutionResult,
} from './execution';
import { canonicalScope, checkFiles, needsGrant, policyFailure, type FileScope } from './policy';
import { Resources, type Resource, type ResourceSpec } from './resources';
import { Scheduler } from './scheduler';
import { Icons } from './icons';
import { referencedIconIds } from '../../sessions/shared/automation-state';

const CALL_TIMEOUT = 60_000;
const OPERATION_TIMEOUT = 10 * 60_000;
type Refusal = Extract<Outcome, { status: 'refused' }>;
const refuse = (code: FailureCode, detail?: RefusalDetail): Refusal => ({
  status: 'refused',
  code,
  dispatched: false,
  ...(detail ? { detail } : {}),
});
const okay = (): Outcome<null> => ({ status: 'verified', value: null });
const cancelled = (): Outcome<never> => ({ status: 'cancelled-before-dispatch', effects: 'none' });
// The WeakMap, not this structural type or any model argument, proves a caller's binding.
export interface BrokerAccess {
  readonly generation: number;
}
interface BoundAccess {
  owner: Owner;
  generation: number;
  active: boolean;
}
interface PendingOperation {
  fact: Operation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  permission: Promise<boolean>;
  resolve: (allowed: boolean) => void;
  approval?: HostApproval;
  denied?: boolean;
  denialMessage?: string;
  grantId?: string;
}
interface Work {
  callId: string;
  controller: AbortController;
  generation: number;
  turn: string;
  target?: TargetRef;
  operation?: PendingOperation;
  dispatched: boolean;
  settled: boolean;
}
interface Owner {
  id: string;
  scope: FileScope;
  policy: AutomationPolicy;
  policyEpoch: number;
  generation: number;
  open: boolean;
  turn: string | null;
  sequence: number;
  activity: Activity;
  imageInput: 'supported' | 'unsupported' | 'unknown';
  operations: Map<string, PendingOperation>;
  grants: Map<string, Grant>;
  ends: GrantEndRecord[];
  actions: Map<string, { hash: string; callId: string }>;
  calls: Set<Work>;
  paused: Set<string>;
  listeners: Set<(event: Envelope<AutomationEvent>) => void>;
}

export class AutomationBroker {
  private readonly epoch = randomUUID();
  private readonly owners = new Map<string, Owner>();
  private readonly accesses = new WeakMap<BrokerAccess, BoundAccess>();
  private readonly resources = new Resources();
  private readonly icons = new Icons();
  private readonly scheduler = new Scheduler();
  private readonly tools = new Map<string, AutomationTool>();
  private foreground: string | null = null;
  private closed = false;
  constructor(
    tools: readonly AutomationTool[] = [],
    private readonly now: () => number = Date.now,
  ) {
    for (const tool of tools) {
      const limit = tool.maxArgumentBytes ?? DEFAULT_ARGUMENT_BYTES;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARGUMENT_BYTES)
        throw new Error('Invalid tool argument limit.');
      if (
        this.tools.has(tool.name) ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) ||
        tool.name === 'automation_capabilities'
      )
        throw new Error('Invalid tool registration.');
      this.tools.set(tool.name, { ...tool, availability: structuredClone(tool.availability) });
    }
  }
  definitions(): readonly AutomationTool[] {
    return [...this.tools.values()];
  }
  async bind(
    id: string,
    cwd: string,
    policy: AutomationPolicy,
    temporaryRoots: readonly string[] = [],
  ): Promise<void> {
    if (this.isClosed()) throw new Error('The broker is closed.');
    const scope = await canonicalScope(cwd, temporaryRoots);
    if (this.isClosed()) throw new Error('The broker is closed.');
    const previous = this.owners.get(id);
    if (previous) {
      if (JSON.stringify(previous.scope) !== JSON.stringify(scope))
        throw new Error('An owner cannot change its file scope.');
      previous.open = true;
      this.setPolicy(id, policy);
      return;
    }
    const owner: Owner = {
      id,
      scope,
      policy: { ...policy },
      policyEpoch: 1,
      generation: 0,
      open: true,
      turn: null,
      sequence: 0,
      imageInput: 'unknown',
      activity: new Activity(
        id,
        (event) => {
          this.emit(id, event);
        },
        this.now,
      ),
      operations: new Map(),
      grants: new Map(),
      ends: [],
      actions: new Map(),
      calls: new Set(),
      paused: new Set(),
      listeners: new Set(),
    };
    this.owners.set(id, owner);
  }
  openAccess(id: string): BrokerAccess {
    const owner = this.owner(id);
    if (!owner.open || this.closed) throw new Error('The owner is closed.');
    this.disconnect(id);
    const access = Object.freeze({ generation: ++owner.generation });
    this.accesses.set(access, { owner, generation: owner.generation, active: true });
    return access;
  }
  active(access: BrokerAccess): boolean {
    const bound = this.accesses.get(access);
    return (
      !!bound &&
      bound.active &&
      bound.owner.open &&
      bound.owner.generation === bound.generation &&
      !this.closed
    );
  }
  revoke(access: BrokerAccess): void {
    const bound = this.accesses.get(access);
    if (!bound?.active) return;
    bound.active = false;
    for (const work of bound.owner.calls)
      if (work.generation === bound.generation) work.controller.abort('access-revoked');
    for (const op of [...bound.owner.operations.values()])
      if (op.fact.accessGeneration === bound.generation)
        this.finishOperation(bound.owner, op, 'access-revoked');
  }
  disconnect(id: string): void {
    const owner = this.owner(id);
    owner.generation += 1;
    this.stop(id, 'access-revoked');
  }
  beginTurn(id: string): string {
    const owner = this.owner(id);
    if (!owner.open) throw new Error('The owner is closed.');
    owner.turn ??= randomUUID();
    return owner.turn;
  }
  endTurn(id: string): void {
    this.stop(id, 'turn-ended');
    this.owner(id).turn = null;
  }
  stop(id: string, reason: EndReason = 'stopped'): void {
    const owner = this.owner(id);
    for (const work of owner.calls) work.controller.abort(reason);
    for (const op of [...owner.operations.values()]) this.finishOperation(owner, op, reason);
    this.state(owner);
  }
  setPolicy(id: string, policy: AutomationPolicy): void {
    const owner = this.owner(id);
    if (owner.policy.mode === policy.mode && owner.policy.sandbox === policy.sandbox) return;
    owner.policy = { ...policy };
    owner.policyEpoch += 1;
    this.stop(id, 'policy-changed');
  }
  register(id: string, spec: ResourceSpec): TargetSummary {
    if (!this.owner(id).open) throw new Error('The owner is closed.');
    const iconId = this.icons.add(id, spec.summary.icon, this.iconIds(this.owner(id)));
    const target = this.resources.add(id, spec, iconId);
    this.state(this.owner(id));
    return target;
  }
  observation(id: string, ref: TargetRef): string {
    return this.resources.observe(id, ref);
  }
  targetChanged(id: string, ref: TargetRef, kind: 'document' | 'geometry'): void {
    this.resources.changed(id, ref, kind);
  }
  async targetEnded(
    id: string,
    ref: TargetRef,
    reason: 'tab-closed' | 'application-quit' | 'backend-lost',
  ): Promise<void> {
    const owner = this.owner(id);
    const removed = this.resources.remove(id, ref);
    const ids = new Set(removed.map((r) => r.target.ref.id));
    for (const work of owner.calls)
      if (work.target && ids.has(work.target.id)) work.controller.abort(reason);
    for (const op of [...owner.operations.values()])
      if (ids.has(op.fact.target.id)) this.finishOperation(owner, op, reason);
    for (const grant of [...owner.grants.values()])
      if (ids.has(grant.target.ref.id)) this.finishGrant(owner, grant, reason);
    for (const r of removed) owner.paused.delete(r.target.ref.id);
    this.state(owner);
    await Promise.allSettled(
      removed.flatMap((r) =>
        r.release ? [r.release(r.target.sharing === 'none' ? 'delete-isolated' : 'detach')] : [],
      ),
    );
  }
  async backendRestarted(backend: string): Promise<void> {
    await Promise.all(
      this.resources
        .backend(backend)
        .map((target) => this.targetEnded(target.owner, target.ref, 'backend-lost')),
    );
  }
  takeover(id: string, target: TargetRef): Outcome<null> {
    const failure = this.resources.failure(id, target);
    if (failure) return refuse(failure);
    const owner = this.owner(id);
    const root = this.resources.resolve(id, target)?.application ?? target;
    owner.paused.add(root.id);
    for (const op of [...owner.operations.values()]) {
      if (op.fact.target.id !== root.id) continue;
      const incident: ActivityIncident = {
        kind: 'takeover',
        at: this.now(),
        operationId: op.fact.id,
        target: { ...target },
        source: 'human',
      };
      const call = owner.activity.list().findLast((record) => record.operationId === op.fact.id);
      if (call) this.recordIncident(id, call.callId, incident);
      this.finishOperation(owner, op, 'takeover');
    }
    this.state(owner);
    return okay();
  }
  handBack(id: string, target: TargetRef): Outcome<null> {
    const failure = this.resources.failure(id, target);
    if (failure) return refuse(failure);
    this.owner(id).paused.delete((this.resources.resolve(id, target)?.application ?? target).id);
    this.state(this.owner(id));
    return okay();
  }
  endOperation(id: string, operationId: string): Outcome<null> {
    const owner = this.owner(id);
    const op = owner.operations.get(operationId);
    if (!op) return refuse('not-found');
    this.finishOperation(owner, op, 'user-ended');
    return okay();
  }
  endGrant(id: string, grantId: string): Outcome<null> {
    const owner = this.owner(id);
    const grant = owner.grants.get(grantId);
    if (!grant) return refuse('not-found');
    this.finishGrant(owner, grant, 'user-ended');
    for (const op of [...owner.operations.values()])
      if (op.fact.target.id === grant.target.ref.id && op.fact.kind === grant.operationKind)
        this.finishOperation(owner, op, 'user-ended');
    this.state(owner);
    return okay();
  }
  answer(id: string, requestId: string, answer: ApprovalAnswer): Outcome<null> {
    const owner = this.owner(id);
    const op = [...owner.operations.values()].find((v) => v.approval?.id === requestId);
    if (!op || op.controller.signal.aborted || op.fact.policyEpoch !== owner.policyEpoch)
      return refuse('not-found');
    if (
      answer.decision === 'deny' &&
      answer.message !== undefined &&
      answer.message.length > AUTOMATION_ACTIVITY_LIMITS.denialCharacters
    )
      return refuse('limit-exceeded');
    const at = this.now();
    const target = op.approval?.target;
    if (!target) return refuse('not-found');
    delete op.approval;
    if (answer.decision === 'deny') {
      op.denied = true;
      if (answer.message !== undefined) op.denialMessage = answer.message;
      owner.activity.approvalAnswered(requestId, answer, at, null);
      op.resolve(false);
      this.finishOperation(owner, op, 'denied');
    } else {
      const grant: Grant = {
        id: randomUUID(),
        target: structuredClone(target),
        summaryAt: this.now(),
        operationKind: op.fact.kind,
        scope: answer.decision === 'allow-once' ? 'operation' : 'session',
        ...(answer.decision === 'allow-once' ? { operationId: op.fact.id } : {}),
        issuedAt: this.now(),
      };
      owner.grants.set(grant.id, grant);
      op.grantId = grant.id;
      owner.activity.approvalAnswered(requestId, answer, at, grant.id);
      op.fact.state = 'active';
      op.resolve(true);
    }
    this.emit(id, { kind: 'approval-answered', id: requestId, at, answer });
    this.state(owner);
    return okay();
  }
  capabilities(id: string): AutomationCapabilities {
    const owner = this.owner(id);
    return {
      policy: { ...owner.policy },
      resultLimits: { ...AUTOMATION_RESULT_LIMITS },
      tools: [...this.tools.values()].map(({ name, family, availability, maxArgumentBytes }) => ({
        name,
        family,
        maxArgumentBytes: maxArgumentBytes ?? DEFAULT_ARGUMENT_BYTES,
        availability: {
          ...structuredClone(availability),
          images: owner.imageInput === 'supported' ? availability.images : owner.imageInput,
        },
      })),
    };
  }
  imageInput(id: string, images: Owner['imageInput']): void {
    this.owner(id).imageInput = images;
    this.state(this.owner(id));
  }
  capabilitiesFor(access: BrokerAccess): AutomationCapabilities {
    return this.capabilities(this.caller(access).id);
  }
  availability(name: string, value: AutomationTool['availability']): void {
    const tool = this.tools.get(name);
    if (!tool) throw new Error('Unknown tool.');
    tool.availability = structuredClone(value);
    for (const owner of this.owners.values()) this.state(owner);
  }
  snapshot(id: string): Envelope<AutomationSnapshot> {
    const owner = this.owner(id);
    return {
      epoch: this.epoch,
      sequence: owner.sequence,
      sessionId: id,
      value: {
        ...this.liveState(owner),
        endedGrants: structuredClone(owner.ends),
        recentCalls: owner.activity.list(),
        presentationNotices: owner.activity.pendingNotices(),
      },
    };
  }
  private liveState(owner: Owner): AutomationLiveState {
    const operations = [...owner.operations.values()].map((op) => structuredClone(op.fact));
    const phase = operations.some((op) => op.state === 'stopping')
      ? 'stopping'
      : [...owner.operations.values()].some((op) => op.approval)
        ? 'waiting-grant'
        : owner.paused.size
          ? 'paused'
          : owner.calls.size
            ? 'acting'
            : 'idle';
    return {
      sessionId: owner.id,
      policy: { ...owner.policy },
      policyEpoch: owner.policyEpoch,
      phase,
      resources: this.resources.list(owner.id),
      operations,
      grants: structuredClone([...owner.grants.values()]),
      pendingApprovals: [...owner.operations.values()].flatMap((op) =>
        op.approval ? [structuredClone(op.approval)] : [],
      ),
      foregroundOwner: this.foreground,
      availability: { tools: 'ready', images: owner.imageInput },
    };
  }
  subscribe(id: string, listener: (event: Envelope<AutomationEvent>) => void): () => void {
    const owner = this.owner(id);
    owner.listeners.add(listener);
    return () => {
      owner.listeners.delete(listener);
    };
  }
  record(id: string, callId: string) {
    return this.owner(id).activity.get(callId);
  }
  frames(id: string, callId: string) {
    return this.owner(id).activity.frames(callId);
  }
  icon(id: string, iconId: string) {
    return this.icons.read(id, iconId, this.iconIds(this.owner(id)));
  }
  private iconIds(owner: Owner): Set<string> {
    const ids = referencedIconIds({
      resources: this.resources.list(owner.id),
      grants: owner.grants.values(),
      endedGrants: owner.ends,
      pendingApprovals: [...owner.operations.values()].flatMap((op) =>
        op.approval ? [op.approval] : [],
      ),
    });
    for (const id of owner.activity.iconIds()) ids.add(id);
    return ids;
  }
  recordIncident(id: string, callId: string, event: ActivityIncident): Outcome<null> {
    const result = this.owner(id).activity.incident(callId, event);
    if (result.status === 'verified') this.emit(id, event);
    return result;
  }
  link(link: ProviderToolLink): Outcome<null> {
    return this.owner(link.sessionId).activity.link(link);
  }
  recordPresentation(id: string, notice: PresentationNotice): Outcome<null> {
    return this.owner(id).activity.presentationChanged(notice);
  }
  prepareNotices(id: string) {
    return this.owner(id).activity.prepareTurn();
  }
  noticesDelivered(id: string, deliveryId: string, accepted: boolean): void {
    this.owner(id).activity.finishTurnDelivery(deliveryId, accepted);
  }

  async dispatch(
    access: BrokerAccess,
    name: string,
    input: unknown,
    options: { actionId: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ToolsetResult> {
    const owner = this.caller(access);
    const tool = this.tools.get(name);
    if (!tool) throw new Error('Unknown tool.');
    const record = owner.activity.start(access.generation, owner.turn, name, tool.family);
    const finish = (outcome: Outcome) => owner.activity.settle(record.callId, outcome);
    if (owner.calls.size >= 32) return finish(refuse('limit-exceeded'));
    if (!owner.turn) return finish(refuse('turn-inactive'));
    let key: string;
    let args: Record<string, unknown>;
    let plan: ExecutionPlan;
    try {
      if (!options.actionId || options.actionId.length > 128)
        return finish(refuse('invalid-request'));
      key = requestKey(input);
      if (Buffer.byteLength(key, 'utf8') > (tool.maxArgumentBytes ?? DEFAULT_ARGUMENT_BYTES))
        return finish(refuse('limit-exceeded'));
      args = tool.inputSchema.parse(JSON.parse(key));
      plan = tool.plan(args);
    } catch {
      return finish(refuse('invalid-request'));
    }
    if (plan.target) {
      const resource = this.resources.resolve(owner.id, plan.target);
      if (resource) owner.activity.target(record.callId, resource.target, plan.delivery);
    }
    const hash = createHash('sha256').update(name).update('\0').update(key).digest('hex');
    const previous = owner.actions.get(options.actionId);
    if (previous) {
      if (previous.hash !== hash) return finish(refuse('request-conflict'));
      const known = owner.activity.get(previous.callId);
      if (!known || known.framesState === 'evicted') return finish(refuse('result-expired'));
      const retained = owner.activity.frames(previous.callId);
      if (retained.status !== 'verified') return finish(refuse('result-expired'));
      if (known.family !== 'panel' && known.target.state === 'resolved')
        owner.activity.target(record.callId, known.target.summary, known.delivery);
      return owner.activity.settle(
        record.callId,
        known.outcome ??
          (known.phase === 'dispatched'
            ? { status: 'dispatched', evidence: 'not-verified' }
            : refuse('busy')),
        retained.value,
        known.family === 'panel' ? known.presentations : [],
      );
    }
    if (owner.actions.size >= 4096) return finish(refuse('limit-exceeded'));
    owner.actions.set(options.actionId, { hash, callId: record.callId });
    const controller = new AbortController();
    const work: Work = {
      callId: record.callId,
      controller,
      generation: access.generation,
      turn: owner.turn,
      ...(plan.target ? { target: { ...plan.target } } : {}),
      dispatched: false,
      settled: false,
    };
    owner.calls.add(work);
    const cancelFromRequest = () => {
      controller.abort('cancelled');
    };
    options.signal?.addEventListener('abort', cancelFromRequest, { once: true });
    if (options.signal?.aborted) cancelFromRequest();
    const timeout = Math.max(1, Math.min(options.timeoutMs ?? CALL_TIMEOUT, CALL_TIMEOUT));
    const timer = setTimeout(() => {
      controller.abort('deadline');
    }, timeout);
    timer.unref();
    try {
      const result = await this.perform(owner, access, tool, args, plan, work);
      return owner.activity.settle(
        record.callId,
        result.outcome,
        result.frames,
        result.presentations,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancelFromRequest);
      if (!work.dispatched || work.settled) this.forgetWork(owner, work);
      this.state(owner);
    }
  }
  private async perform(
    owner: Owner,
    access: BrokerAccess,
    tool: AutomationTool,
    args: Record<string, unknown>,
    plan: ExecutionPlan,
    work: Work,
  ): Promise<ExecutionResult> {
    const check = () => this.check(owner, access, tool, plan, work);
    const aborted = () => work.controller.signal.aborted;
    let failure = check();
    if (failure) return { outcome: failure };
    if (aborted()) return { outcome: cancelled() };
    const resource = plan.target && this.resources.resolve(owner.id, plan.target);
    if (resource) owner.activity.target(work.callId, resource.target, plan.delivery);
    const files = await checkFiles(
      owner.policy,
      owner.scope,
      plan.files ?? [],
      plan.destinationKnown ?? true,
    );
    if ('code' in files) return { outcome: refuse(files.code) };
    failure = check();
    if (failure || aborted())
      return { outcome: aborted() ? cancelled() : (failure ?? refuse('operation-ended')) };
    if (plan.operation && resource) {
      const authorizationTarget =
        (plan.operation === 'application-background' ||
          plan.operation === 'application-foreground') &&
        resource.application
          ? this.resources.resolve(owner.id, resource.application)
          : resource;
      if (!authorizationTarget) return { outcome: refuse('stale-target') };
      work.operation = this.operation(
        owner,
        access,
        authorizationTarget,
        plan.operation,
        work.callId,
      );
      const stopWithOperation = () => {
        work.controller.abort(work.operation?.controller.signal.reason);
      };
      const op = work.operation;
      op.controller.signal.addEventListener('abort', stopWithOperation, { once: true });
      if (op.controller.signal.aborted) stopWithOperation();
      owner.activity.phase(work.callId, 'waiting', op.fact.id, op.grantId ?? null);
      const allowed = await untilAbort(op.permission, work.controller.signal, () => false);
      op.controller.signal.removeEventListener('abort', stopWithOperation);
      if (!allowed)
        return {
          outcome: op.denied
            ? refuse(
                'denied',
                op.denialMessage === undefined
                  ? undefined
                  : { kind: 'denial', message: op.denialMessage },
              )
            : cancelled(),
        };
    }
    const mutates = plan.effect === 'mutate' || plan.effect === 'activate';
    const desktop =
      plan.delivery === 'foreground' || plan.effect === 'activate' || (mutates && plan.mayActivate);
    const foreground = plan.delivery === 'foreground' || plan.effect === 'activate';
    const lane = resource?.application
      ? this.resources.resolve(owner.id, resource.application)
      : resource;
    const keys = [
      ...(mutates && lane ? [`target:${lane.backend}:${lane.key}`] : []),
      ...(desktop ? ['desktop'] : []),
    ];
    const release = await this.scheduler.acquire(keys, work.controller.signal);
    if (!release) return { outcome: aborted() ? cancelled() : refuse('busy') };
    failure = check();
    if (failure || aborted()) {
      release();
      return { outcome: aborted() ? cancelled() : (failure ?? refuse('operation-ended')) };
    }
    const checkedFiles = await checkFiles(
      owner.policy,
      owner.scope,
      plan.files ?? [],
      plan.destinationKnown ?? true,
    );
    failure = check();
    if ('code' in checkedFiles || failure || aborted()) {
      release();
      return {
        outcome: aborted()
          ? cancelled()
          : 'code' in checkedFiles
            ? refuse(checkedFiles.code)
            : (failure ?? refuse('operation-ended')),
      };
    }
    work.dispatched = true;
    owner.activity.phase(
      work.callId,
      'dispatched',
      work.operation?.fact.id ?? null,
      work.operation?.grantId ?? null,
    );
    if (foreground) this.foreground = owner.id;
    this.state(owner);
    // Subscribers can stop synchronously while the dispatch event is emitted.
    if (aborted()) {
      work.dispatched = false;
      release();
      if (foreground && this.foreground === owner.id) this.foreground = null;
      return { outcome: cancelled() };
    }
    let running: Promise<ExecutionResult>;
    try {
      running = tool.execute(args, {
        signal: work.controller.signal,
        owner: owner.id,
        turnId: work.turn,
        operationId: work.operation?.fact.id ?? null,
        report: (incident) => {
          const fact = {
            ...incident,
            at: this.now(),
            operationId: work.operation?.fact.id ?? null,
          };
          if (fact.kind === 'secure-input') return this.recordIncident(owner.id, work.callId, fact);
          if (!plan.target) return refuse('invalid-request');
          return this.recordIncident(owner.id, work.callId, {
            ...fact,
            target: { ...plan.target },
          });
        },
        ...(plan.target ? { target: { ...plan.target } } : {}),
        paths: checkedFiles.paths,
      });
    } catch {
      running = Promise.reject(new Error('Backend failed.'));
    }
    const execution = running
      .then((result): ExecutionResult => {
        if (!validResult(result, plan.target)) throw new Error('Invalid or unbounded tool result.');
        return result;
      })
      .catch((): ExecutionResult => ({
        outcome: { status: 'indeterminate', reason: 'backend-lost', exclusionHeld: false },
      }))
      .finally(() => {
        work.settled = true;
        release();
        if (foreground && this.foreground === owner.id) this.foreground = null;
        owner.activity.settledExclusion(work.callId);
        this.forgetWork(owner, work);
        this.state(owner);
      });
    return untilAbort(execution, work.controller.signal, () => ({
      outcome: {
        status: 'indeterminate',
        reason:
          work.controller.signal.reason === 'deadline' ? 'timeout' : 'cancelled-after-dispatch',
        exclusionHeld: keys.length > 0,
      },
    }));
  }
  private check(
    owner: Owner,
    access: BrokerAccess,
    tool: AutomationTool,
    plan: ExecutionPlan,
    work: Work,
  ): Refusal | null {
    if (!this.active(access)) return refuse('access-revoked');
    if (!owner.turn || owner.turn !== work.turn) return refuse('turn-inactive');
    const denied = policyFailure(owner.policy, plan.effect);
    if (denied || (owner.policy.sandbox === 'read-only' && plan.delivery === 'foreground'))
      return refuse(denied ?? 'sandbox-denied');
    if (plan.setup) return refuse('setup-required', { kind: 'setup', requirement: plan.setup });
    if (tool.availability.tools !== 'ready')
      return refuse('setup-required', {
        kind: 'availability',
        reason: tool.availability.reason ?? { code: 'not-probed' },
      });
    if (
      plan.requiresImages &&
      (tool.availability.images !== 'supported' || owner.imageInput !== 'supported')
    )
      return refuse('image-input-unsupported');
    if (
      tool.family === 'panel'
        ? plan.operation !== null || plan.effect !== 'present'
        : plan.effect !== 'metadata' && (!plan.target || !plan.operation)
    )
      return refuse('invalid-request');
    if (plan.effect === 'metadata' && (plan.target || plan.operation))
      return refuse('invalid-request');
    if (
      (plan.delivery === 'foreground' || plan.effect === 'activate') &&
      plan.operation !== 'application-foreground' &&
      plan.operation !== 'system-dialog'
    )
      return refuse('invalid-request');
    if (plan.target) {
      const failure = this.resources.failure(owner.id, plan.target);
      if (failure) return refuse(failure);
      const resource = this.resources.resolve(owner.id, plan.target);
      if (!resource) return refuse('stale-target');
      const root = resource.application
        ? this.resources.resolve(owner.id, resource.application)
        : resource;
      if (!root) return refuse('stale-target');
      if (plan.mayActivate && !root.mayActivate) return refuse('invalid-request');
      if (plan.operation === 'browser-tab' && resource.kind !== 'browser-tab')
        return refuse('invalid-request');
      if (
        (plan.operation === 'application-background' ||
          plan.operation === 'application-foreground') &&
        resource.kind !== 'application' &&
        !resource.application
      )
        return refuse('invalid-request');
      if (plan.operation === 'system-dialog' && resource.kind !== 'system-dialog')
        return refuse('invalid-request');
      if (
        owner.paused.has(plan.target.id) ||
        (resource.application && owner.paused.has(resource.application.id))
      )
        return refuse('target-paused');
      if (
        plan.requiresObservation &&
        (!plan.observationId || !this.resources.current(owner.id, plan.target, plan.observationId))
      )
        return refuse('stale-observation');
    }
    const op = work.operation;
    if (
      op &&
      (op.controller.signal.aborted ||
        op.fact.policyEpoch !== owner.policyEpoch ||
        op.fact.turn !== owner.turn ||
        op.fact.deadline <= this.now())
    )
      return refuse('operation-ended');
    return null;
  }
  private operation(
    owner: Owner,
    access: BrokerAccess,
    resource: Resource,
    kind: Operation['kind'],
    callId: string,
  ): PendingOperation {
    const turn = owner.turn;
    if (!turn) throw new Error('No active turn.');
    const prior = [...owner.operations.values()].find(
      (op) =>
        op.fact.target.id === resource.target.ref.id &&
        op.fact.kind === kind &&
        op.fact.turn === owner.turn &&
        op.fact.accessGeneration === access.generation &&
        !op.controller.signal.aborted,
    );
    if (prior) return prior;
    let resolve!: (allowed: boolean) => void;
    const permission = new Promise<boolean>((done) => {
      resolve = done;
    });
    const fact: Operation = {
      id: randomUUID(),
      owner: owner.id,
      turn,
      accessGeneration: access.generation,
      target: { ...resource.target.ref },
      kind,
      policyEpoch: owner.policyEpoch,
      state: 'active',
      targetMayActivate: resource.mayActivate,
      deadline: this.now() + OPERATION_TIMEOUT,
    };
    const op: PendingOperation = {
      fact,
      controller: new AbortController(),
      permission,
      resolve,
      timer: setTimeout(() => {
        this.finishOperation(owner, op, 'deadline');
      }, OPERATION_TIMEOUT),
    };
    op.timer.unref();
    owner.operations.set(fact.id, op);
    const covered = [...owner.grants.values()].find(
      (grant) =>
        grant.scope === 'session' &&
        grant.target.ref.id === fact.target.id &&
        grant.target.ref.generation === fact.target.generation &&
        grant.operationKind === fact.kind,
    );
    if (needsGrant(owner.policy, fact.kind, resource.target.sharing) && !covered) {
      fact.state = 'waiting';
      op.approval = {
        id: `host:${randomUUID()}`,
        callId,
        source: 'host',
        operation: structuredClone(fact),
        target: structuredClone(resource.target),
        canAllowForSession: true,
        requestedAt: this.now(),
      };
      owner.activity.approvalRequested(op.approval);
    } else {
      if (covered) op.grantId = covered.id;
      resolve(true);
    }
    this.state(owner);
    return op;
  }
  private finishOperation(owner: Owner, op: PendingOperation, reason: EndReason): void {
    if (op.controller.signal.aborted) return;
    clearTimeout(op.timer);
    op.controller.abort(reason);
    op.resolve(false);
    delete op.approval;
    for (const work of owner.calls) if (work.operation === op) work.controller.abort(reason);
    const running = [...owner.calls].some(
      (work) => work.operation === op && work.dispatched && !work.settled,
    );
    op.fact.state = running ? 'stopping' : 'ended';
    if (!running) owner.operations.delete(op.fact.id);
    for (const grant of [...owner.grants.values()])
      if (grant.operationId === op.fact.id) this.finishGrant(owner, grant, reason);
    const end = { at: this.now(), reason };
    owner.activity.operationEnded(op.fact.id, end);
    this.emit(owner.id, { kind: 'operation-ended', id: op.fact.id, ...end });
    this.state(owner);
  }
  private finishGrant(owner: Owner, grant: Grant, reason: EndReason): void {
    if (!owner.grants.delete(grant.id)) return;
    const record = { grant: structuredClone(grant), endedAt: this.now(), reason };
    owner.ends.push(record);
    if (owner.ends.length > AUTOMATION_ACTIVITY_LIMITS.endedGrants) {
      const evicted = owner.ends.shift();
      if (evicted) this.emit(owner.id, { kind: 'grant-end-removed', grantId: evicted.grant.id });
    }
    owner.activity.grantEnded(record);
    this.emit(owner.id, { kind: 'grant-ended', record });
  }
  private forgetWork(owner: Owner, work: Work): void {
    owner.calls.delete(work);
    const op = work.operation;
    if (op?.fact.state === 'waiting' && ![...owner.calls].some((w) => w.operation === op)) {
      this.finishOperation(owner, op, 'stopped');
    }
    if (op?.controller.signal.aborted && ![...owner.calls].some((w) => w.operation === op))
      owner.operations.delete(op.fact.id);
  }
  async closeOwner(id: string, remove = false): Promise<void> {
    const owner = this.owner(id);
    owner.open = false;
    this.stop(id, 'session-closed');
    owner.turn = null;
    for (const grant of [...owner.grants.values()])
      this.finishGrant(owner, grant, 'session-closed');
    await Promise.all(
      this.resources.list(id).map((target) => this.targetEnded(id, target.ref, 'backend-lost')),
    );
    if (remove) {
      owner.listeners.clear();
      this.owners.delete(id);
      this.icons.release(id);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.owners.keys()].map((id) => this.closeOwner(id)));
    for (const id of this.owners.keys()) this.icons.release(id);
  }
  private caller(access: BrokerAccess): Owner {
    const bound = this.accesses.get(access);
    if (!bound || !this.active(access)) throw new Error('access-revoked');
    return bound.owner;
  }
  private isClosed(): boolean {
    return this.closed;
  }
  private owner(id: string): Owner {
    const owner = this.owners.get(id);
    if (!owner) throw new Error('Unknown automation owner.');
    return owner;
  }
  private state(owner: Owner): void {
    if (owner.listeners.size) this.emit(owner.id, { kind: 'state', state: this.liveState(owner) });
  }
  private emit(id: string, event: AutomationEvent): void {
    const owner = this.owners.get(id);
    if (!owner) return;
    const envelope = {
      epoch: this.epoch,
      sequence: ++owner.sequence,
      sessionId: id,
      value: structuredClone(event),
    };
    for (const listener of owner.listeners) {
      try {
        listener(structuredClone(envelope));
      } catch {
        console.error('An automation state listener failed.');
      }
    }
  }
}

function untilAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  cancelledValue: () => T,
): Promise<T> {
  if (signal.aborted) return Promise.resolve(cancelledValue());
  return new Promise((resolve) => {
    const aborted = () => {
      resolve(cancelledValue());
    };
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(resolve, aborted).finally(() => {
      signal.removeEventListener('abort', aborted);
    });
  });
}
