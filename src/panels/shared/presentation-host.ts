import type {
  Outcome,
  PresentationNotice,
  PresentationSummary,
  RefusalDetail,
} from '../../sessions/shared/automation';
import type {
  Artifact,
  PanelBox,
  Placement,
  PresentedContent,
  PresentationRefusal,
  PresentationState,
  SessionPanel,
} from './presentation';

// Backend contract; the renderer continues to use PresentationBridge. Inline artifacts are converted
// to owner-bound handles before any command reaches the window.
export type PanelInput = PresentedContent | { kind: 'artifact'; artifact: Artifact };
export type PanelRequest =
  | { kind: 'list'; offset?: number }
  | {
      kind: 'present';
      reuseKey: string;
      version: number;
      title: string;
      items: PanelInput[];
      placement: Placement;
    }
  | { kind: 'update'; presentationId: string; version: number; title: string; items: PanelInput[] }
  | { kind: 'arrange'; presentationId: string; version: number; placement: Placement }
  | { kind: 'close'; presentationId: string; version: number };

export interface PanelResult {
  outcome: Outcome;
  presentations?: readonly PresentationSummary[];
}
export interface PanelExecutor {
  execute(
    owner: string,
    requestId: string,
    request: PanelRequest,
    signal: AbortSignal,
  ): Promise<PanelResult>;
}
export interface PresentationHostPorts {
  hasOwner(owner: string): boolean;
  // Canonical existing file checked by the file service. This never grants a new path.
  file(owner: string, path: string): Promise<string | null>;
  // Returns the permitted target's own title, never a translated UI label.
  resource(
    owner: string,
    content: Extract<PresentedContent, { kind: 'browser' | 'computer' }>,
  ): string | null;
  // Backpressure means the host retains the latest report for a later flush.
  notice(owner: string, notice: PresentationNotice): Outcome<null>;
}
export interface PanelListing {
  renderer: 'ready' | 'unavailable';
  presentations: readonly (PresentationSummary & { reuseKey: string })[];
  sessionPanels: readonly SessionPanel[];
  nextOffset: number | null;
  unresolved: readonly PresentationState[];
}

// Compile-time checks against the projection consumed by activity. Neither copy can drift silently.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type PresentationContractChecks = [
  Assert<Equal<PresentedContent, PresentationSummary['items'][number]['content']>>,
  Assert<Equal<PanelBox, NonNullable<PresentationSummary['items'][number]['box']>>>,
  Assert<Equal<PresentationRefusal, Extract<RefusalDetail, { kind: 'presentation' }>['reason']>>,
];
