import { createHash, randomUUID } from 'node:crypto';
import type {
  FailureCode,
  JsonValue,
  PresentationNotice,
  PresentationSummary,
} from '../../sessions/shared/automation';
import {
  commandWithinLimits,
  DEFAULT_PLACEMENT,
  sameContent,
  PRESENTATION_HOLD_MS,
  type Artifact,
  type PresentedContent,
  type Placement,
  type PresentationAnswer,
  type PresentationCommand,
  type PresentationHostMessage,
  type PresentationRendererMessage,
  type PresentationState,
  type SessionPanel,
  type ShowOutcome,
} from '../shared/presentation';
import type {
  PanelExecutor,
  PanelInput,
  PanelListing,
  PanelRequest,
  PanelResult,
  PresentationHostPorts,
} from '../shared/presentation-host';
import { Artifacts } from './artifacts';
import { presentationRendererSchema } from './presentation-validation';

export const PRESENTATION_HOST_LIMITS = {
  presentations: 512,
  commandsPerOwner: 4096,
  resultsPerOwner: 256,
  showsPerPage: 4096,
  pending: 64,
  answerMs: PRESENTATION_HOLD_MS + 5_000,
  listBytes: 32 * 1024,
} as const;
interface Entry {
  id: string;
  owner: string;
  reuseKey: string;
  title: string;
  items: PresentedContent[];
  state: PresentationState;
  uncertain: boolean;
  contentVersion: number;
  placement: Placement;
  placementVersion: number;
  artifactsEvicted: boolean;
}
interface KeptCommand {
  owner: string;
  hash: string;
  result: Promise<PanelResult>;
  settle(result: PanelResult): void;
  command?: PresentationCommand;
  entry?: Entry;
  proposed?: { title: string; items: PresentedContent[] };
  answered: boolean;
  returned: boolean;
  evictable: boolean;
  expired?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
  wasUncertain?: boolean;
  pins?: string[];
}
interface KeptShow {
  owner: string;
  controller: AbortController;
  answered: boolean;
  evictable: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
// Renderer callbacks and async validation can settle a command between two checks.
function hasReturned(command: KeptCommand): boolean {
  return command.returned;
}
const refused = (code: FailureCode): PanelResult => ({
  outcome: { status: 'refused', code, dispatched: false },
});
const uncertain = (
  code: 'renderer-unavailable' | 'deadline-exceeded' | 'cancelled' = 'renderer-unavailable',
): PanelResult => ({
  outcome: {
    status: 'indeterminate',
    reason:
      code === 'cancelled'
        ? 'cancelled-after-dispatch'
        : code === 'deadline-exceeded'
          ? 'timeout'
          : 'backend-lost',
    exclusionHeld: false,
  },
});
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
// What the user's request to see something again came to, from the present it led to.
function showOutcome({ outcome }: PanelResult): ShowOutcome {
  if (outcome.status === 'verified') return 'shown';
  if (outcome.status === 'indeterminate' && outcome.reason === 'presentation-race') return 'busy';
  if (outcome.status !== 'refused') return 'unavailable';
  switch (outcome.code) {
    case 'result-expired':
      return 'expired';
    case 'needs-user-action':
      return 'unsaved-changes';
    case 'busy':
    case 'layout-conflict':
      return 'busy';
    default:
      return 'unavailable';
  }
}
function summary(entry: Entry): PresentationSummary {
  return {
    id: entry.id,
    title: entry.title,
    version: entry.state.version,
    items: entry.items.map((content, i) => ({ content, box: entry.state.boxes[i] ?? null })),
  };
}
const failures: Record<Extract<PresentationAnswer, { kind: 'refused' }>['code'], FailureCode> = {
  'command-conflict': 'request-conflict',
  'invalid-command': 'invalid-request',
  'item-count-mismatch': 'invalid-request',
  'presentation-unknown': 'not-found',
  'presentation-changed': 'layout-conflict',
  'stale-epoch': 'renderer-unavailable',
  'unsaved-changes': 'needs-user-action',
  'wrong-owner': 'wrong-owner',
  busy: 'busy',
};

// An acknowledged projection, never a layout. Runtime ports come from app composition; the only
// writer of boxes/open state is the window. Model calls cannot select an owner, epoch or command ID.
export class PresentationHost implements PanelExecutor {
  private readonly entries = new Map<string, Entry>();
  private readonly commands = new Map<string, KeptCommand>();
  private readonly shows = new Map<string, KeptShow>();
  private readonly notices = new Map<string, PresentationNotice>();
  private readonly artifacts: Artifacts;
  private epoch: string | null = null;
  private readonly retiredEpochs = new Set<string>();
  private send: ((message: PresentationHostMessage) => void) | null = null;
  private sessionPanels: SessionPanel[] = [];
  constructor(private readonly ports: PresentationHostPorts) {
    this.artifacts = new Artifacts();
  }

  connect(send: (message: PresentationHostMessage) => void): void {
    this.disconnect();
    this.send = send;
  }
  disconnect(): void {
    this.send = null;
    for (const show of this.shows.values()) {
      clearTimeout(show.timer);
      show.controller.abort();
    }
    this.shows.clear();
    if (this.epoch) {
      this.retiredEpochs.add(this.epoch);
      if (this.retiredEpochs.size > 128)
        this.retiredEpochs.delete(this.retiredEpochs.values().next().value ?? '');
    }
    this.epoch = null;
    this.sessionPanels = [];
    for (const kept of this.commands.values()) {
      if (!kept.returned) this.finish(kept, uncertain());
      kept.answered = true;
    }
    for (const entry of this.entries.values()) this.gone(entry);
    this.collectArtifacts();
    this.flushNotices();
  }
  receive(raw: unknown): boolean {
    const parsed = presentationRendererSchema.safeParse(raw);
    if (!parsed.success || !this.send) return false;
    const message: PresentationRendererMessage = parsed.data;
    if (message.kind === 'snapshot') {
      if (this.retiredEpochs.has(message.epoch)) return false;
      if (this.epoch !== message.epoch) {
        // A fresh page may report before the navigation callback. Retired pages cannot take the
        // connection back; IPC additionally checks the live main frame.
        if (this.epoch !== null) {
          const send = this.send;
          this.disconnect();
          this.send = send;
        }
        this.epoch = message.epoch;
      }
      this.sessionPanels = message.sessionPanels.filter((p) => this.ports.hasOwner(p.owner));
      for (const state of message.presentations) this.changed(state);
      this.flushNotices();
      return true;
    }
    if (message.epoch !== this.epoch) return false;
    if (message.kind === 'changed') this.changed(message.state);
    else if (message.kind === 'show') {
      // IDs belong to this page, across its sessions. Retransmission must neither race the first
      // reply with busy nor reopen something the user closed after that first request completed.
      if (this.shows.has(message.requestId)) return false;
      if (this.shows.size >= PRESENTATION_HOST_LIMITS.showsPerPage) {
        const oldest = [...this.shows].find(([, show]) => show.evictable);
        if (oldest) this.shows.delete(oldest[0]);
        else {
          this.send({
            kind: 'show-answer',
            epoch: message.epoch,
            requestId: message.requestId,
            outcome: 'busy',
          });
          return false;
        }
      }
      const show: KeptShow = {
        owner: message.owner,
        controller: new AbortController(),
        answered: false,
        evictable: false,
      };
      this.shows.set(message.requestId, show);
      // Each of the user's requests gets one answer, for the page that asked, while it lasts.
      const answer = (outcome: ShowOutcome, evictable = true) => {
        if (this.epoch !== message.epoch || this.shows.get(message.requestId) !== show) return;
        show.evictable = evictable;
        if (show.answered) return;
        show.answered = true;
        clearTimeout(show.timer);
        this.send?.({
          kind: 'show-answer',
          epoch: message.epoch,
          requestId: message.requestId,
          outcome,
        });
      };
      // This deadline includes validation before a renderer command exists. Abort the underlying
      // request too, so a slow permission check cannot later open panels after reporting failure.
      show.timer = setTimeout(() => {
        show.controller.abort();
        answer('unavailable', false);
      }, PRESENTATION_HOST_LIMITS.answerMs);
      show.timer.unref();
      if (!this.ports.hasOwner(message.owner)) {
        answer('unavailable');
        return false;
      }
      const entry =
        'presentationId' in message
          ? this.entries.get(message.presentationId)
          : [...this.entries.values()].find(
              (entry) =>
                entry.owner === message.owner &&
                entry.items.some((item) => sameContent(item, message.content)),
            );
      const resourceTitle =
        'content' in message ? this.ports.resource(message.owner, message.content) : null;
      if (
        (entry && entry.owner !== message.owner) ||
        ('presentationId' in message && !entry) ||
        (!entry && !resourceTitle)
      ) {
        answer('unavailable');
        return false;
      }
      const request: PanelRequest = entry
        ? {
            kind: 'present',
            reuseKey: entry.reuseKey,
            version: entry.state.version,
            title: entry.title,
            items: entry.items,
            placement: entry.placement,
          }
        : {
            kind: 'present',
            reuseKey: `show:${'content' in message ? JSON.stringify(message.content) : ''}`,
            version: 0,
            title: resourceTitle?.slice(0, 120) ?? '',
            items: 'content' in message ? [message.content] : [],
            placement: DEFAULT_PLACEMENT,
          };
      void this.execute(message.owner, randomUUID(), request, show.controller.signal)
        .then((result) => {
          for (const p of result.presentations ?? []) {
            const e = this.entries.get(p.id);
            if (e) this.notice(e);
          }
          answer(
            showOutcome(result),
            result.outcome.status === 'verified' ||
              result.outcome.status === 'refused' ||
              result.outcome.status === 'cancelled-before-dispatch',
          );
        })
        .catch(() => {
          answer('unavailable', false);
        });
    } else this.answer(message);
    this.flushNotices();
    return true;
  }
  artifact(id: string): Artifact | null {
    // The UI can read only an artifact named by a retained presentation, through the trusted frame.
    for (const entry of this.entries.values()) {
      if (
        this.ports.hasOwner(entry.owner) &&
        entry.items.some((item) => item.kind === 'artifact' && item.artifactId === id)
      )
        return this.artifacts.get(entry.owner, id);
    }
    for (const kept of this.commands.values()) {
      if (
        !kept.answered &&
        kept.command?.epoch === this.epoch &&
        this.ports.hasOwner(kept.owner) &&
        kept.proposed?.items.some((item) => item.kind === 'artifact' && item.artifactId === id)
      )
        return this.artifacts.get(kept.owner, id);
    }
    return null;
  }
  flushNotices(): void {
    for (const [id, notice] of this.notices) {
      if (
        !this.ports.hasOwner(notice.owner) ||
        this.ports.notice(notice.owner, notice).status === 'verified'
      )
        this.notices.delete(id);
    }
  }
  removeOwner(owner: string): void {
    for (const show of this.shows.values()) if (show.owner === owner) show.controller.abort();
    for (const [id, entry] of this.entries)
      if (entry.owner === owner) {
        this.entries.delete(id);
        this.notices.delete(id);
      }
    for (const [id, kept] of this.commands)
      if (kept.owner === owner) {
        this.cancel(kept);
        this.finish(kept, uncertain('cancelled'));
        this.commands.delete(id);
      }
    this.artifacts.removeOwner(owner);
  }
  execute(
    owner: string,
    requestId: string,
    request: PanelRequest,
    signal: AbortSignal,
  ): Promise<PanelResult> {
    this.flushNotices();
    if (!this.ports.hasOwner(owner)) return Promise.resolve(refused('wrong-owner'));
    if (signal.aborted)
      return Promise.resolve({ outcome: { status: 'cancelled-before-dispatch', effects: 'none' } });
    const key = JSON.stringify([owner, requestId]);
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.commands.get(key);
    if (previous)
      return previous.hash === hash
        ? previous.result
        : Promise.resolve(refused('request-conflict'));
    if (
      [...this.commands.values()].filter((c) => c.owner === owner).length >=
      PRESENTATION_HOST_LIMITS.commandsPerOwner
    ) {
      const oldest = [...this.commands].find(([, c]) => c.owner === owner && c.evictable);
      if (!oldest) return Promise.resolve(refused('limit-exceeded'));
      this.commands.delete(oldest[0]);
    }
    let settle!: (result: PanelResult) => void;
    const result = new Promise<PanelResult>((resolve) => {
      settle = resolve;
    });
    const kept: KeptCommand = {
      owner,
      hash,
      result,
      settle,
      answered: false,
      returned: false,
      evictable: false,
    };
    this.commands.set(key, kept);
    const abort = () => {
      if (kept.returned) return;
      this.cancel(kept);
      // A synchronous cancellation acknowledgement may already have settled the command.
      if (hasReturned(kept)) return;
      if (kept.command && kept.entry) kept.entry.uncertain = true;
      this.finish(
        kept,
        kept.command
          ? uncertain('cancelled')
          : {
              outcome: { status: 'cancelled-before-dispatch', effects: 'none' },
            },
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    kept.dispose = () => {
      signal.removeEventListener('abort', abort);
    };
    void this.dispatch(kept, request, signal).catch(() => {
      this.finish(kept, kept.command ? uncertain() : refused('invalid-request'));
    });
    return result;
  }
  private async dispatch(
    kept: KeptCommand,
    request: PanelRequest,
    signal: AbortSignal,
  ): Promise<void> {
    if (request.kind === 'list') {
      this.finish(kept, this.list(kept.owner, request.offset ?? 0));
      return;
    }
    if (!this.epoch || !this.send) {
      this.finish(kept, refused('renderer-unavailable'));
      return;
    }
    if (
      [...this.commands.values()].filter((c) => !c.returned).length >
      PRESENTATION_HOST_LIMITS.pending
    ) {
      this.finish(kept, refused('busy'));
      return;
    }
    let entry =
      request.kind === 'present'
        ? [...this.entries.values()].find(
            (e) => e.owner === kept.owner && e.reuseKey === request.reuseKey,
          )
        : this.entries.get(request.presentationId);
    if (entry && entry.owner !== kept.owner) {
      this.finish(kept, refused('wrong-owner'));
      return;
    }
    if (!entry && request.kind !== 'present') {
      this.finish(kept, refused('not-found'));
      return;
    }
    if (entry && [...this.commands.values()].some((c) => c.entry === entry && !c.returned)) {
      this.finish(kept, refused('busy'));
      return;
    }
    if (request.version !== (entry?.state.version ?? 0)) {
      this.finish(kept, this.conflict(entry));
      return;
    }
    if (entry?.uncertain && request.kind !== 'present') {
      this.finish(kept, uncertain());
      return;
    }
    // Reserve the identity before async file checks; another present for the same reuse key waits.
    if (!entry && request.kind === 'present') {
      this.prune();
      if (this.entries.size >= PRESENTATION_HOST_LIMITS.presentations) {
        this.finish(kept, refused('limit-exceeded'));
        return;
      }
      const id = randomUUID();
      entry = {
        id,
        owner: kept.owner,
        reuseKey: request.reuseKey,
        title: request.title,
        items: [],
        state: { presentationId: id, owner: kept.owner, version: 0, boxes: [] },
        uncertain: false,
        contentVersion: 0,
        placement: request.placement,
        placementVersion: 0,
        artifactsEvicted: false,
      };
      this.entries.set(id, entry);
    }
    if (!entry) {
      this.finish(kept, refused('not-found'));
      return;
    }
    kept.entry = entry;
    const epoch = this.epoch;
    // Pin all referenced handles before allocating any new payload. A later item in this request
    // must not be reclaimed while an earlier inline item makes room in the cache.
    const pins: string[] =
      request.kind === 'present' || request.kind === 'update'
        ? request.items.flatMap((item) =>
            item.kind === 'artifact' &&
            'artifactId' in item &&
            this.artifacts.has(kept.owner, item.artifactId)
              ? [item.artifactId]
              : [],
          )
        : [];
    kept.pins = pins;
    this.collectArtifacts();
    const items: PresentedContent[] = [];
    if (request.kind === 'present' || request.kind === 'update') {
      for (const item of request.items) {
        if (kept.returned) return;
        const content = await this.content(kept.owner, item, pins);
        if (hasReturned(kept)) {
          this.collectArtifacts();
          return;
        }
        if ('code' in content) {
          this.finish(kept, refused(content.code));
          return;
        }
        items.push(content.content);
      }
    }
    if (
      signal.aborted ||
      !this.connected(epoch) ||
      !this.ports.hasOwner(kept.owner) ||
      request.version !== entry.state.version
    ) {
      this.finish(
        kept,
        signal.aborted
          ? { outcome: { status: 'cancelled-before-dispatch', effects: 'none' } }
          : epoch !== this.epoch
            ? refused('renderer-unavailable')
            : this.conflict(entry),
      );
      return;
    }
    if (
      items.some((item) =>
        item.kind === 'artifact'
          ? !this.artifacts.has(kept.owner, item.artifactId)
          : item.kind === 'file'
            ? false
            : !this.ports.resource(kept.owner, item),
      )
    ) {
      this.finish(kept, refused('not-found'));
      return;
    }
    const basis = {
      commandId: randomUUID(),
      epoch,
      owner: kept.owner,
      presentationId: entry.id,
      version: request.version,
    };
    const command: PresentationCommand =
      request.kind === 'present'
        ? { ...basis, kind: 'present', title: request.title, items, placement: request.placement }
        : request.kind === 'update'
          ? { ...basis, kind: 'update', title: request.title, items }
          : request.kind === 'arrange'
            ? { ...basis, kind: 'arrange', placement: request.placement }
            : { ...basis, kind: 'close' };
    if (!commandWithinLimits(command)) {
      this.finish(kept, refused('invalid-request'));
      return;
    }
    kept.command = command;
    kept.wasUncertain = entry.uncertain;
    if (request.kind === 'present' || request.kind === 'update')
      kept.proposed = { title: request.title, items };
    if (kept.proposed) entry.uncertain = true;
    kept.timer = setTimeout(() => {
      this.cancel(kept);
      if (!kept.returned) {
        entry.uncertain = true;
        this.finish(kept, uncertain('deadline-exceeded'));
      }
    }, PRESENTATION_HOST_LIMITS.answerMs);
    this.send(command);
  }
  private async content(
    owner: string,
    item: PanelInput,
    pins: string[],
  ): Promise<{ content: PresentedContent } | { code: FailureCode }> {
    if (item.kind === 'file') {
      const path = await this.ports.file(owner, item.path);
      return path ? { content: { kind: 'file', path } } : { code: 'sandbox-denied' };
    }
    if (item.kind !== 'artifact')
      return this.ports.resource(owner, item) ? { content: item } : { code: 'not-found' };
    if ('artifactId' in item) {
      if (!this.artifacts.has(owner, item.artifactId)) {
        const known = [...this.entries.values()].some(
          (entry) => entry.owner === owner && entry.items.some((kept) => sameContent(kept, item)),
        );
        return { code: known ? 'result-expired' : 'not-found' };
      }
      pins.push(item.artifactId);
      return { content: item };
    }
    let stored = this.artifacts.put(owner, item.artifact);
    for (const entry of this.entries.values()) {
      if (!('code' in stored) || stored.code !== 'limit-exceeded') break;
      if (
        entry.owner !== owner ||
        entry.artifactsEvicted ||
        entry.uncertain ||
        entry.state.boxes.some(Boolean) ||
        !entry.items.some((item) => item.kind === 'artifact') ||
        [...this.commands.values()].some((c) => c.entry === entry && !c.answered)
      )
        continue;
      // Descriptors/version guards remain listable. Only the least recently changed closed
      // payloads of this owner can go; open presentations and pending pins still retain shared IDs.
      entry.artifactsEvicted = true;
      this.collectArtifacts();
      stored = this.artifacts.put(owner, item.artifact);
    }
    if ('code' in stored) return stored;
    pins.push(stored.id);
    return { content: { kind: 'artifact', artifactId: stored.id } };
  }
  private answer(answer: PresentationAnswer): void {
    const kept = [...this.commands.values()].find((c) => c.command?.commandId === answer.commandId);
    if (!kept?.command || !kept.entry || kept.answered || kept.command.epoch !== answer.epoch)
      return;
    const { entry, command } = kept;
    if (
      'state' in answer &&
      answer.state &&
      (answer.state.owner !== entry.owner || answer.state.presentationId !== entry.id)
    )
      return;
    if (answer.kind === 'refused' && answer.presentationId !== entry.id) return;
    if (answer.kind === 'applied') {
      if (
        answer.state.version !== command.version + 1 ||
        answer.state.boxes.length !== (kept.proposed?.items ?? entry.items).length
      )
        return;
      const later = entry.state.version > answer.state.version;
      if (kept.proposed && answer.state.version > entry.contentVersion) {
        entry.title = kept.proposed.title;
        entry.items = kept.proposed.items;
        entry.contentVersion = answer.state.version;
        entry.artifactsEvicted = false;
      }
      if (
        (command.kind === 'present' || command.kind === 'arrange') &&
        answer.state.version > entry.placementVersion
      ) {
        entry.placement = structuredClone(command.placement);
        entry.placementVersion = answer.state.version;
      }
      if (!later) entry.state = structuredClone(answer.state);
      entry.uncertain = this.otherPending(kept);
      if (later || kept.returned) this.notice(entry);
      const result: PanelResult = later
        ? {
            outcome: { status: 'indeterminate', reason: 'presentation-race', exclusionHeld: false },
            presentations: [summary(entry)],
          }
        : {
            outcome: { status: 'verified' as const, value: json(summary(entry)) },
            presentations: [summary(entry)],
          };
      this.finish(kept, result);
    } else if (answer.kind === 'cancelled') {
      entry.uncertain =
        this.otherPending(kept) ||
        (entry.contentVersion <= command.version && kept.wasUncertain === true);
      this.finish(kept, { outcome: { status: 'cancelled-before-dispatch', effects: 'none' } });
    } else {
      entry.uncertain =
        this.otherPending(kept) ||
        (entry.contentVersion <= command.version && kept.wasUncertain === true);
      if (answer.state) this.changed(answer.state);
      this.finish(kept, {
        outcome: {
          status: 'refused',
          code: failures[answer.code],
          dispatched: false,
          detail: {
            kind: 'presentation',
            reason: answer.code,
            current: entry.uncertain || !entry.items.length ? null : summary(entry),
          },
        },
        presentations: entry.uncertain || !entry.items.length ? [] : [summary(entry)],
      });
    }
    kept.answered = true;
    kept.evictable = true;
    this.touch(entry);
    this.trimResults(kept.owner);
    this.collectArtifacts();
  }
  private otherPending(kept: KeptCommand): boolean {
    return [...this.commands.values()].some(
      (other) =>
        other !== kept &&
        other.entry === kept.entry &&
        !!other.proposed &&
        !other.returned &&
        !other.answered,
    );
  }
  private touch(entry: Entry): void {
    if (!this.entries.has(entry.id)) return;
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
  }
  private changed(state: PresentationState): void {
    const entry = this.entries.get(state.presentationId);
    if (entry?.owner !== state.owner || state.version <= entry.state.version) return;
    const pending = [...this.commands.values()].find(
      (c) => c.entry === entry && c.command && !c.answered,
    );
    if (
      state.boxes.length !== entry.items.length &&
      state.boxes.length !== pending?.proposed?.items.length
    )
      return;
    entry.state = structuredClone(state);
    this.touch(entry);
    if (pending?.proposed) entry.uncertain = true;
    if (!entry.uncertain) this.notice(entry);
  }
  private notice(entry: Entry): void {
    if (!entry.items.length || entry.uncertain) return;
    this.notices.set(entry.id, {
      noticeId: `${entry.id}:${String(entry.state.version)}`,
      owner: entry.owner,
      reuseKey: entry.reuseKey,
      presentation: summary(entry),
    });
    this.flushNotices();
  }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size < PRESENTATION_HOST_LIMITS.presentations) return;
      if (
        entry.uncertain ||
        entry.state.boxes.some(Boolean) ||
        this.notices.has(id) ||
        [...this.commands.values()].some((c) => c.entry === entry && !c.returned)
      )
        continue;
      this.entries.delete(id);
    }
  }
  private gone(entry: Entry): void {
    if (!entry.state.boxes.some(Boolean) && !entry.uncertain) return;
    entry.state = {
      ...entry.state,
      version: entry.state.version + 1,
      boxes: entry.items.map(() => null),
    };
    entry.uncertain = false;
    this.notice(entry);
  }
  private cancel(kept: KeptCommand): void {
    if (kept.command && !kept.answered && this.epoch === kept.command.epoch)
      this.send?.({ kind: 'cancel', epoch: kept.command.epoch, commandId: kept.command.commandId });
  }
  private connected(epoch: string): boolean {
    return this.send !== null && this.epoch === epoch;
  }
  private finish(kept: KeptCommand, result: PanelResult): void {
    if (kept.returned) return;
    kept.returned = true;
    kept.evictable =
      result.outcome.status === 'verified' ||
      result.outcome.status === 'refused' ||
      result.outcome.status === 'cancelled-before-dispatch';
    clearTimeout(kept.timer);
    kept.dispose?.();
    if (
      kept.entry &&
      !kept.entry.items.length &&
      (result.outcome.status === 'refused' || result.outcome.status === 'cancelled-before-dispatch')
    )
      this.entries.delete(kept.entry.id);
    kept.settle(structuredClone(result));
    if (!kept.command) kept.answered = true;
    this.trimResults(kept.owner);
    this.collectArtifacts();
  }
  private collectArtifacts(): void {
    const ids = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.artifactsEvicted) continue;
      for (const item of entry.items) if (item.kind === 'artifact') ids.add(item.artifactId);
    }
    for (const kept of this.commands.values()) {
      if (
        kept.answered ||
        (kept.command && kept.command.version + 1 <= (kept.entry?.contentVersion ?? 0))
      )
        continue;
      for (const id of kept.pins ?? []) ids.add(id);
    }
    this.artifacts.retain(ids);
  }
  private trimResults(owner: string): void {
    const complete = [...this.commands.values()].filter(
      (c) => c.owner === owner && c.answered && c.returned && !c.expired,
    );
    for (const older of complete.slice(0, -PRESENTATION_HOST_LIMITS.resultsPerOwner)) {
      // The recent identity window outlives bulky results. Uncertain requests stay pinned even
      // after that rolling window would otherwise evict them.
      older.result = Promise.resolve(refused('result-expired'));
      older.settle = () => undefined;
      older.expired = true;
      delete older.entry;
      delete older.proposed;
      delete older.pins;
      delete older.command;
    }
  }
  private conflict(entry?: Entry): PanelResult {
    const current = entry && !entry.uncertain && entry.items.length ? summary(entry) : null;
    return {
      outcome: {
        status: 'refused',
        code: 'layout-conflict',
        dispatched: false,
        detail: { kind: 'presentation', reason: 'presentation-changed', current },
      },
      presentations: current ? [current] : [],
    };
  }
  private list(owner: string, offset: number): PanelResult {
    const entries = [...this.entries.values()].filter(
      (e) => e.owner === owner && (e.items.length || e.uncertain),
    );
    const sessions = this.sessionPanels.filter((p) => p.owner === owner);
    const listing: PanelListing = {
      renderer: this.epoch && this.send ? 'ready' : 'unavailable',
      presentations: [],
      unresolved: [],
      sessionPanels: [],
      nextOffset: null,
    };
    const presentations: (PresentationSummary & { reuseKey: string })[] = [];
    const unresolved: PresentationState[] = [];
    const sessionPanels: SessionPanel[] = [];
    for (let index = offset; index < sessions.length + entries.length; index++) {
      const session = sessions[index];
      const entry = entries[index - sessions.length];
      if (session) sessionPanels.push(session);
      else if (entry?.uncertain) unresolved.push(entry.state);
      else if (entry) presentations.push({ ...summary(entry), reuseKey: entry.reuseKey });
      if (
        Buffer.byteLength(
          JSON.stringify({ ...listing, sessionPanels, presentations, unresolved }),
        ) > PRESENTATION_HOST_LIMITS.listBytes
      ) {
        if (session) sessionPanels.pop();
        else if (entry?.uncertain) unresolved.pop();
        else presentations.pop();
        listing.nextOffset = index;
        break;
      }
    }
    return {
      outcome: {
        status: 'verified',
        value: json({ ...listing, sessionPanels, presentations, unresolved }),
      },
    };
  }
}
