import { randomUUID } from 'node:crypto';
import type { FailureCode, TargetRef, TargetSummary } from '../../sessions/shared/automation';
import type { MessageImage } from '../../sessions/shared/events';

export interface ResourceSpec {
  backend: string;
  // Backend-provided identity, never a model-selected lane or a public native ID.
  key: string;
  mayActivate: boolean;
  summary: Omit<TargetSummary, 'ref' | 'owner' | 'iconId' | 'applicationName' | 'application'> & {
    icon?: MessageImage;
  };
  kind: TargetRef['kind'];
  application?: TargetRef;
  documentGeneration?: number;
  geometryGeneration?: number;
  release?: (how: 'delete-isolated' | 'detach') => Promise<void>;
}
export interface Resource extends Omit<ResourceSpec, 'summary'> {
  summary: Omit<TargetSummary, 'ref' | 'owner'>;
  target: TargetSummary;
  documentGeneration: number;
  geometryGeneration: number;
}
interface Observation {
  owner: string;
  target: TargetRef;
  document: number;
  geometry: number;
}

export class Resources {
  private readonly entries = new Map<string, Resource>();
  private readonly observations = new Map<string, Observation>();
  private generation = 0;

  add(owner: string, spec: ResourceSpec, iconId?: string): TargetSummary {
    if (this.list(owner).length >= 128) throw new Error('Resource limit exceeded.');
    if (
      spec.kind === 'browser-tab' &&
      [...this.entries.values()].some(
        (r) => r.kind === spec.kind && r.backend === spec.backend && r.key === spec.key,
      )
    )
      throw new Error('This tab already has an owner.');
    const application = spec.application && this.resolve(owner, spec.application);
    if (spec.application && application?.kind !== 'application')
      throw new Error('A window needs its owner’s current application.');
    const summary: Resource['summary'] = {
      name: spec.summary.name,
      ...(application
        ? { applicationName: application.target.name, application: { ...application.target.ref } }
        : {}),
      ...(spec.summary.address !== undefined ? { address: spec.summary.address } : {}),
      ...(spec.summary.sharing ? { sharing: spec.summary.sharing } : {}),
      ...(spec.summary.browser ? { browser: spec.summary.browser } : {}),
      ...(spec.summary.profile ? { profile: structuredClone(spec.summary.profile) } : {}),
      ...(iconId ? { iconId } : {}),
    };
    const target: TargetSummary = {
      ...summary,
      owner,
      ref: { id: randomUUID(), kind: spec.kind, generation: ++this.generation },
    };
    this.entries.set(target.ref.id, {
      ...spec,
      ...(spec.application ? { application: { ...spec.application } } : {}),
      summary,
      target,
      documentGeneration: spec.documentGeneration ?? 0,
      geometryGeneration: spec.geometryGeneration ?? 0,
    });
    return structuredClone(target);
  }
  failure(owner: string, ref: TargetRef): FailureCode | null {
    const r = this.entries.get(ref.id);
    if (r?.target.ref.generation !== ref.generation || r.kind !== ref.kind) return 'stale-target';
    return r.target.owner === owner ? null : 'wrong-owner';
  }
  resolve(owner: string, ref: TargetRef): Resource | undefined {
    return this.failure(owner, ref) === null ? this.entries.get(ref.id) : undefined;
  }
  list(owner: string): TargetSummary[] {
    return [...this.entries.values()]
      .filter((r) => r.target.owner === owner)
      .map((r) => structuredClone(r.target));
  }
  observe(owner: string, ref: TargetRef): string {
    const r = this.resolve(owner, ref);
    if (!r) throw new Error('The target is no longer available.');
    const own = [...this.observations].filter(([, v]) => v.owner === owner);
    const oldest = own[0];
    if (own.length >= 256 && oldest) this.observations.delete(oldest[0]);
    const id = randomUUID();
    this.observations.set(id, {
      owner,
      target: { ...ref },
      document: r.documentGeneration,
      geometry: r.geometryGeneration,
    });
    return id;
  }
  current(owner: string, ref: TargetRef, observationId: string): boolean {
    const r = this.resolve(owner, ref);
    const seen = this.observations.get(observationId);
    return (
      !!r &&
      !!seen &&
      seen.owner === owner &&
      seen.target.id === ref.id &&
      seen.target.generation === ref.generation &&
      seen.document === r.documentGeneration &&
      seen.geometry === r.geometryGeneration
    );
  }
  changed(owner: string, ref: TargetRef, change: 'document' | 'geometry'): void {
    const r = this.resolve(owner, ref);
    if (!r) return;
    if (change === 'document') r.documentGeneration += 1;
    else r.geometryGeneration += 1;
  }
  describeBrowserTab(owner: string, ref: TargetRef, name: string, address: string | null): boolean {
    const resource = this.resolve(owner, ref);
    if (resource?.kind !== 'browser-tab') return false;
    if (resource.target.name === name && resource.target.address === (address ?? undefined))
      return false;
    resource.target.name = name;
    if (address === null) delete resource.target.address;
    else resource.target.address = address;
    return true;
  }
  remove(owner: string, ref: TargetRef): Resource[] {
    const root = this.resolve(owner, ref);
    if (!root) return [];
    const removed = [...this.entries.values()].filter(
      (r) => r === root || r.application?.id === ref.id,
    );
    for (const r of removed) {
      this.entries.delete(r.target.ref.id);
      for (const [id, seen] of this.observations)
        if (seen.target.id === r.target.ref.id) this.observations.delete(id);
    }
    return removed;
  }
  backend(name: string): TargetSummary[] {
    return [...this.entries.values()]
      .filter((r) => r.backend === name)
      .map((r) => structuredClone(r.target));
  }
}
