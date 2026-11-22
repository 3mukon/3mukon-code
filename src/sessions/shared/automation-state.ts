import type {
  AutomationEvent,
  AutomationLiveState,
  AutomationSnapshot,
  Envelope,
  TargetSummary,
} from './automation';

// A snapshot includes history; only these fields belong in a live-state event.
export function liveAutomationState(state: AutomationLiveState): AutomationLiveState {
  return {
    sessionId: state.sessionId,
    policy: state.policy,
    policyEpoch: state.policyEpoch,
    phase: state.phase,
    resources: state.resources,
    operations: state.operations,
    grants: state.grants,
    pendingApprovals: state.pendingApprovals,
    foregroundOwner: state.foregroundOwner,
    ...(state.foregroundControl ? { foregroundControl: state.foregroundControl } : {}),
    ...(state.pausedTargets?.length ? { pausedTargets: state.pausedTargets } : {}),
    availability: state.availability,
  };
}

// null asks the subscriber to fetch a snapshot. Older deliveries are harmless; a gap or a new
// epoch cannot be filled by guessing which events were missed. Inputs remain owned by the caller.
export function foldAutomationEvent(
  before: Envelope<AutomationSnapshot>,
  event: Envelope<AutomationEvent>,
): Envelope<AutomationSnapshot> | null {
  if (before.sessionId !== event.sessionId || before.epoch !== event.epoch) return null;
  if (event.sequence <= before.sequence) return before;
  if (event.sequence !== before.sequence + 1) return null;
  // Preserve untouched history by reference; a live-state event must not copy retained history.
  const value = { ...before.value };
  switch (event.value.kind) {
    case 'state':
      if (event.value.state.sessionId !== before.sessionId) return null;
      delete value.foregroundControl;
      delete value.pausedTargets;
      return {
        ...event,
        value: { ...value, ...structuredClone(liveAutomationState(event.value.state)) },
      };
    case 'tool-call': {
      const call = event.value.call;
      if (call.sessionId !== before.sessionId) return null;
      const found = value.recentCalls.find((record) => record.callId === call.callId);
      if (!found) value.recentCalls = [...value.recentCalls, structuredClone(call)];
      else if (call.revision > found.revision)
        value.recentCalls = value.recentCalls.map((record) =>
          record.callId === call.callId ? structuredClone(call) : record,
        );
      break;
    }
    case 'tool-call-removed': {
      const id = event.value.callId;
      value.recentCalls = value.recentCalls.filter((record) => record.callId !== id);
      break;
    }
    case 'presentation-notices':
      value.presentationNotices = structuredClone(event.value.notices);
      break;
    case 'grant-ended': {
      const record = event.value.record;
      const found = value.endedGrants.some((end) => end.grant.id === record.grant.id);
      value.endedGrants = found
        ? value.endedGrants.map((end) =>
            end.grant.id === record.grant.id ? structuredClone(record) : end,
          )
        : [...value.endedGrants, structuredClone(record)];
      break;
    }
    case 'grant-end-removed': {
      const id = event.value.grantId;
      value.endedGrants = value.endedGrants.filter((end) => end.grant.id !== id);
      break;
    }
    default:
      // Notifications have already retained their facts in a state or call-record event.
      break;
  }
  return { ...event, value };
}

// The icon read boundary uses only IDs named by retained facts, not whether bytes happen to remain
// cached. Iterable inputs let main inspect its records without cloning them into a snapshot.
export function referencedIconIds(facts: {
  [K in 'resources' | 'grants' | 'endedGrants' | 'pendingApprovals' | 'recentCalls']?: Iterable<
    AutomationSnapshot[K][number]
  >;
}): Set<string> {
  const ids = new Set<string>();
  const add = (target: TargetSummary) => {
    if (target.iconId) ids.add(target.iconId);
  };
  for (const target of facts.resources ?? []) add(target);
  for (const grant of facts.grants ?? []) add(grant.target);
  for (const end of facts.endedGrants ?? []) add(end.grant.target);
  for (const request of facts.pendingApprovals ?? []) add(request.target);
  for (const call of facts.recentCalls ?? []) {
    if (call.family !== 'panel' && call.target.state === 'resolved') add(call.target.summary);
    if (call.approval) add(call.approval.request.target);
    if (call.grantEnd) add(call.grantEnd.grant.target);
  }
  return ids;
}
