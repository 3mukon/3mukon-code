import { randomUUID } from 'node:crypto';
import type {
  Bounds,
  Frame,
  Outcome,
  Preview,
  TargetRef,
  TargetSummary,
} from '../../sessions/shared/automation';
import type { NativeHelper } from './helper';
import { foregroundAction } from './native-protocol';
import type {
  NativeAction,
  NativeApplication,
  NativeEvent,
  NativeObservation,
  NativeWindow,
} from './native-protocol';

export const NATIVE_BACKEND = 'native';
export type ApplicationRef = TargetRef & { kind: 'application' };
export type WindowRef = TargetRef & { kind: 'window' };
export type NativeTarget = ApplicationRef | WindowRef;
type NativePort = Pick<NativeHelper, 'runningApplications' | 'operate'>;
type Ended = 'application-quit' | 'backend-lost';

export interface ComputerResources {
  register(
    owner: string,
    spec: {
      key: string;
      kind: NativeTarget['kind'];
      name: string;
      application?: ApplicationRef;
      release(): Promise<void>;
    },
  ): TargetSummary;
  changed(owner: string, ref: WindowRef, change: 'document' | 'geometry'): void;
  observation(owner: string, ref: WindowRef): string;
  ended(owner: string, ref: NativeTarget, reason: Ended, reportedBy?: string): Promise<void>;
  finish(owner: string, ref: ApplicationRef): Outcome<null>;
}

interface Discovery {
  id: string;
  generation: string;
  application: NativeApplication;
  name: string;
}
interface Application {
  identity: Discovery;
  ref: ApplicationRef;
}
interface Window {
  application: Application;
  ref: WindowRef;
  nativeId: string;
  bounds: Bounds;
  minimized: boolean;
  geometry: number;
  nextPreview?: number;
  previewing?: boolean;
  observation?: {
    id: string;
    nativeId: string;
    hasImage: boolean;
    elements: NativeObservation['elements'];
  };
}
interface Owner {
  discovery: Discovery[];
  applications: Map<string, Application>;
  windows: Map<string, Window>;
}
interface Operation {
  id: string;
  callId: string;
  signal: AbortSignal;
}
export type ControlSurface = (
  owner: string,
  target: WindowRef,
  signal: AbortSignal,
) => Promise<number | undefined>;
const verified = <T>(value: T): Outcome<T> => ({ status: 'verified', value });
function refused<T = never>(code: Extract<Outcome, { status: 'refused' }>['code']): Outcome<T> {
  return { status: 'refused', code, dispatched: false };
}
const cancelled = (): Outcome<never> => ({ status: 'cancelled-before-dispatch', effects: 'none' });
const processKey = (application: NativeApplication) =>
  `${String(application.pid)}:${application.processStart}`;
const asApplication = (ref: TargetRef): ApplicationRef => ({ ...ref, kind: 'application' });
const asWindow = (ref: TargetRef): WindowRef => ({ ...ref, kind: 'window' });
const PREVIEW_INTERVAL_MS = 750;
const MAX_PENDING_PREVIEWS = 2;

function windowFrame(
  target: WindowRef,
  id: string,
  bounds: Bounds,
  capture: NonNullable<NativeObservation['image']>,
  geometry: number,
): Frame {
  return {
    target: { ...target },
    observationId: id,
    documentGeneration: null,
    geometryGeneration: geometry,
    capturedAt: capture.capturedAt,
    image: { data: capture.data, mediaType: capture.mediaType },
    imageSize: { width: capture.width, height: capture.height },
    viewport: { x: 0, y: 0, width: bounds.width, height: bounds.height },
    units: 'window-points',
    imageToViewport: [bounds.width / capture.width, 0, 0, bounds.height / capture.height, 0, 0],
  };
}

// Model-facing resources never contain native PIDs, window numbers or helper receipts. The
// same process uses one lane key across owners, and each window has owner-specific observations.
export class NativeComputer {
  private readonly owners = new Map<string, Owner>();
  private pendingPreviews = 0;

  constructor(
    private readonly native: NativePort,
    private readonly resources: ComputerResources,
    private readonly controlSurface?: ControlSurface,
  ) {}

  async discover(owner: string, signal: AbortSignal) {
    const stopped = () => signal.aborted;
    if (stopped()) return cancelled();
    const reply = await this.native.runningApplications();
    if (stopped()) return cancelled();
    if (reply.status !== 'verified') return reply;
    const state = this.owner(owner);
    const { generation, applications, truncated } = reply.value;
    state.discovery = applications.map(({ name, ...application }) => {
      const existing = state.discovery.find(
        (item) =>
          item.generation === generation &&
          processKey(item.application) === processKey(application),
      );
      return { id: existing?.id ?? randomUUID(), generation, application, name };
    });
    if (!truncated) {
      const live = new Set(applications.map(processKey));
      await Promise.all(
        [...state.applications.values()]
          .filter(
            (target) =>
              target.identity.generation === generation &&
              !live.has(processKey(target.identity.application)),
          )
          .map((target) => this.resources.ended(owner, target.ref, 'application-quit')),
      );
    }
    if (stopped()) return cancelled();
    return verified({
      applications: state.discovery.map(({ id, name, application: { bundleId } }) => ({
        id,
        name,
        bundleId,
      })),
      truncated,
    });
  }

  async select(owner: string, id: string, signal: AbortSignal): Promise<Outcome<ApplicationRef>> {
    const state = this.owners.get(owner);
    const identity = state?.discovery.find((item) => item.id === id);
    if (!state || !identity) return refused('stale-target');
    const confirmed = await this.native.operate(
      { kind: 'application', application: identity.application },
      {
        generation: identity.generation,
        signal,
      },
    );
    if (confirmed.status !== 'verified') return confirmed;
    if (signal.aborted || this.owners.get(owner) !== state) return cancelled();
    if (!state.discovery.some((item) => item.id === id && item.generation === identity.generation))
      return refused('stale-target');
    const key = processKey(identity.application);
    const existing = state.applications.get(key);
    if (existing?.identity.generation === identity.generation) return verified({ ...existing.ref });
    if (state.applications.size >= 16) return refused('limit-exceeded');
    try {
      const target = this.resources.register(owner, {
        kind: 'application',
        key,
        name: identity.name,
        release: () => {
          state.applications.delete(key);
          return Promise.resolve();
        },
      });
      const ref = asApplication(target.ref);
      state.applications.set(key, { identity, ref });
      return verified({ ...ref });
    } catch {
      return refused('limit-exceeded');
    }
  }

  async windows(owner: string, application: ApplicationRef, operation: Operation) {
    const state = this.owners.get(owner);
    const target = this.application(state, application);
    if (!state || !target) return refused('stale-target');
    const { generation, application: process } = target.identity;
    const reply = await this.native.operate(
      { kind: 'windows', application: process, operation: operation.id },
      {
        generation,
        signal: operation.signal,
      },
    );
    if (reply.status !== 'verified') {
      if (reply.status === 'refused' && reply.code === 'stale-target')
        await this.resources.ended(owner, target.ref, 'application-quit', operation.callId);
      return reply;
    }
    const stopped = () =>
      operation.signal.aborted || this.application(state, application) !== target;
    if (stopped()) return cancelled();
    const { windows, truncated } = reply.value;
    if (!truncated) {
      const live = new Set(windows.map((window) => window.id.toLowerCase()));
      await Promise.all(
        [...state.windows.values()]
          .filter((window) => window.application === target && !live.has(window.nativeId))
          .map((window) => this.resources.ended(owner, window.ref, 'backend-lost')),
      );
    }
    if (stopped()) return cancelled();
    const found = windows.flatMap((window) => {
      const kept = this.retainWindow(owner, state, target, window);
      return kept
        ? [
            {
              target: { ...kept.ref },
              title: window.title,
              bounds: window.bounds,
              minimized: window.minimized,
            },
          ]
        : [];
    });
    return verified({ windows: found, truncated: truncated || found.length < windows.length });
  }

  async observe(owner: string, ref: WindowRef, image: boolean, operation: Operation) {
    const window = this.window(owner, ref);
    if (!window) return { outcome: refused('stale-target') };
    const reply = await this.native.operate(
      {
        kind: 'observe',
        window: window.nativeId,
        scope: ref.id,
        image,
        operation: operation.id,
      },
      { generation: window.application.identity.generation, signal: operation.signal },
    );
    if (reply.status !== 'verified') {
      if (reply.status === 'refused' && reply.code === 'stale-observation')
        this.invalidate(owner, window);
      await this.retireWindow(owner, window, reply, operation.callId);
      return { outcome: reply };
    }
    if (operation.signal.aborted || this.window(owner, ref) !== window)
      return { outcome: cancelled() };
    const { id, bounds, elements, truncated, image: capture } = reply.value;
    if (image !== !!capture) return { outcome: refused('background-unavailable') };
    this.geometry(owner, window, bounds, window.minimized);
    this.resources.changed(owner, ref, 'document');
    const observationId = this.resources.observation(owner, ref);
    window.observation = { id: observationId, nativeId: id, hasImage: !!capture, elements };
    const frames = capture
      ? [windowFrame(ref, observationId, bounds, capture, window.geometry)]
      : [];
    return {
      outcome: verified({
        observationId,
        bounds: { ...bounds },
        elements: elements.map((element) => ({ ...element })),
        truncated,
      }),
      frames,
    };
  }

  async preview(owner: string, targetId: string): Promise<Outcome<Preview>> {
    const window = this.owners.get(owner)?.windows.get(targetId);
    if (!window) return verified({ status: 'unavailable', reason: 'target-state-unsupported' });
    const now = performance.now();
    if (
      this.pendingPreviews >= MAX_PENDING_PREVIEWS ||
      window.previewing ||
      now < (window.nextPreview ?? 0)
    )
      return refused('busy');
    window.nextPreview = now + PREVIEW_INTERVAL_MS;
    window.previewing = true;
    this.pendingPreviews++;
    try {
      const { application, generation } = window.application.identity;
      const reply = await this.native.operate(
        { kind: 'preview', application, window: window.nativeId, operation: randomUUID() },
        { generation, signal: AbortSignal.timeout(2_000) },
      );
      if (this.window(owner, window.ref) !== window)
        return verified({ status: 'unavailable', reason: 'connection-lost' });
      if (reply.status !== 'verified') {
        if (reply.status !== 'refused') return reply;
        if (reply.code === 'busy') return reply;
        return verified({
          status: 'unavailable',
          reason:
            reply.code === 'setup-required'
              ? reply.detail?.kind === 'setup'
                ? 'permission-required'
                : 'connection-lost'
              : 'target-state-unsupported',
        });
      }
      if ('reason' in reply.value)
        return verified({ status: 'unavailable', reason: reply.value.reason });
      const { id, bounds, image } = reply.value.frame;
      return verified({
        status: 'frame',
        freshness: 'captured',
        frame: windowFrame(window.ref, id, bounds, image, window.geometry),
      });
    } finally {
      this.pendingPreviews--;
      window.previewing = false;
    }
  }

  async reveal(owner: string, ref: WindowRef): Promise<Outcome<null>> {
    const window = this.window(owner, ref);
    if (!window) return refused('stale-target');
    const reply = await this.native.operate(
      { kind: 'reveal', window: window.nativeId, operation: randomUUID() },
      { generation: window.application.identity.generation, signal: AbortSignal.timeout(2_000) },
    );
    return reply;
  }

  actionLabel(owner: string, ref: WindowRef, observationId: string, element: number) {
    const observed = this.window(owner, ref)?.observation;
    if (observed?.id === observationId)
      return observed.elements.find((control) => control.id === element)?.label;
  }

  targetBounds(owner: string, ref: TargetRef): Bounds | undefined {
    const window = ref.kind === 'window' ? this.window(owner, asWindow(ref)) : undefined;
    return window && { ...window.bounds };
  }

  async action(
    owner: string,
    ref: WindowRef,
    observationId: string,
    action: NativeAction,
    operation: Operation,
    event: (event: NativeEvent) => void,
  ): Promise<Outcome> {
    const window = this.window(owner, ref);
    if (!window) return refused('stale-target');
    const seen = window.observation;
    if (seen?.id !== observationId) return refused('stale-observation');
    if (['point-click', 'point-scroll', 'drag'].includes(action.kind) && !seen.hasImage)
      return refused('stale-observation');
    const surface = foregroundAction(action) ? this.controlSurface : undefined;
    const control = surface && (await surface(owner, ref, operation.signal));
    if (operation.signal.aborted) return cancelled();
    if (surface && !control) return refused('background-unavailable');
    if (this.window(owner, ref) !== window) return refused('stale-target');
    if (window.observation !== seen) return refused('stale-observation');
    const reply = await this.native.operate(
      {
        kind: 'action',
        window: window.nativeId,
        scope: ref.id,
        observation: seen.nativeId,
        action,
        ...(control ? { controlRevision: control } : {}),
        operation: operation.id,
      },
      { generation: window.application.identity.generation, signal: operation.signal, event },
    );
    if (reply.status === 'refused') {
      if (reply.code === 'stale-observation') this.invalidate(owner, window);
      await this.retireWindow(owner, window, reply, operation.callId);
    } else if (reply.status !== 'cancelled-before-dispatch') {
      const key = processKey(window.application.identity.application);
      for (const [id, state] of this.owners) {
        for (const target of state.windows.values())
          if (processKey(target.application.identity.application) === key)
            this.invalidate(id, target);
      }
    }
    return reply;
  }

  release(owner: string, ref: ApplicationRef): Outcome<null> {
    const application = this.application(this.owners.get(owner), ref);
    if (!application) return refused('stale-target');
    for (const window of this.owners.get(owner)?.windows.values() ?? []) {
      if (window.application === application) this.invalidate(owner, window);
    }
    return this.resources.finish(owner, application.ref);
  }

  closeOwner(owner: string): void {
    this.owners.delete(owner);
  }

  generationEnded(generation: string): void {
    for (const [id, state] of this.owners) {
      state.discovery = state.discovery.filter((item) => item.generation !== generation);
      for (const target of state.applications.values()) {
        if (target.identity.generation === generation)
          void this.resources.ended(id, target.ref, 'backend-lost');
      }
    }
  }

  private owner(id: string): Owner {
    let state = this.owners.get(id);
    if (!state) {
      state = { discovery: [], applications: new Map(), windows: new Map() };
      this.owners.set(id, state);
    }
    return state;
  }

  private application(state: Owner | undefined, ref: ApplicationRef): Application | undefined {
    return [...(state?.applications.values() ?? [])].find(
      (target) => target.ref.id === ref.id && target.ref.generation === ref.generation,
    );
  }

  private window(owner: string, ref: WindowRef): Window | undefined {
    const window = this.owners.get(owner)?.windows.get(ref.id);
    return window?.ref.generation === ref.generation ? window : undefined;
  }

  private retainWindow(
    owner: string,
    state: Owner,
    application: Application,
    row: NativeWindow,
  ): Window | undefined {
    const nativeId = row.id.toLowerCase();
    const existing = [...state.windows.values()].find(
      (w) => w.nativeId === nativeId && w.application === application,
    );
    if (existing) {
      this.geometry(owner, existing, row.bounds, row.minimized);
      return existing;
    }
    if (state.windows.size >= 64) return undefined;
    try {
      const summary = this.resources.register(owner, {
        kind: 'window',
        key: nativeId,
        name: row.title,
        application: application.ref,
        release: () => {
          state.windows.delete(summary.ref.id);
          return Promise.resolve();
        },
      });
      const ref = asWindow(summary.ref);
      const window = {
        ref,
        nativeId,
        application,
        bounds: row.bounds,
        minimized: row.minimized,
        geometry: 0,
      };
      state.windows.set(ref.id, window);
      return window;
    } catch {
      return undefined;
    }
  }

  private geometry(owner: string, window: Window, bounds: Bounds, minimized: boolean): void {
    const prior = window.bounds;
    if (
      prior.x === bounds.x &&
      prior.y === bounds.y &&
      prior.width === bounds.width &&
      prior.height === bounds.height &&
      window.minimized === minimized
    )
      return;
    window.bounds = bounds;
    window.minimized = minimized;
    window.geometry++;
    delete window.observation;
    this.resources.changed(owner, window.ref, 'geometry');
  }

  private invalidate(owner: string, window: Window): void {
    if (window.observation) {
      delete window.observation;
      this.resources.changed(owner, window.ref, 'document');
    }
  }

  private async retireWindow(
    owner: string,
    window: Window,
    outcome: Outcome<unknown>,
    reportedBy: string,
  ): Promise<void> {
    if (outcome.status === 'refused' && outcome.code === 'stale-target')
      await this.resources.ended(owner, window.ref, 'backend-lost', reportedBy);
  }
}
