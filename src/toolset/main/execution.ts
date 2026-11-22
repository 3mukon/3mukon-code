import type { z } from 'zod';
import type {
  Availability,
  BrowserActionSummary,
  ComputerActionSummary,
  Delivery,
  Frame,
  JsonValue,
  OperationKind,
  Outcome,
  PresentationSummary,
  SetupRequirement,
  TargetRef,
} from '../../sessions/shared/automation';
import type { Effect, FileIntent } from './policy';
import { imageTypeOf } from '../../sessions/shared/images';
import { AUTOMATION_RESULT_LIMITS } from '../../sessions/shared/automation';
export const DEFAULT_ARGUMENT_BYTES = 256 * 1024;
export const MAX_ARGUMENT_BYTES = 16 * 1024 * 1024;

// Only trusted, app-composed tool implementations build plans. Effects and lanes never come
// straight from model booleans. No backend process is started by registering or discovering a tool.
export interface PlannedAction {
  browserAction?: BrowserActionSummary;
  computerAction?: ComputerActionSummary;
}
export interface ExecutionPlan extends PlannedAction {
  target?: TargetRef;
  operation: OperationKind | null;
  effect: Effect;
  delivery: Delivery;
  mayActivate: boolean;
  observationId?: string;
  requiresObservation?: boolean;
  requiresImages?: boolean;
  files?: readonly FileIntent[];
  destinationKnown?: boolean;
  // Sanitized address of a browser navigation, shown when the call first asks for a tab grant.
  browserAddress?: string;
  // An unmet per-call setup requirement from cached feature facts, not model-supplied authority.
  setup?: SetupRequirement;
}
export type IncidentReport =
  | { kind: 'target-self-activated'; cause: 'popup' | 'dialog' | 'unknown' }
  | { kind: 'dialog-dismissed'; dialog: 'alert' | 'confirm' | 'prompt' }
  | { kind: 'secure-input'; enabled: boolean };
export interface ExecutionContext {
  callId: string;
  signal: AbortSignal;
  owner: string;
  turnId: string;
  operationId: string | null;
  // Retained with this call; receipt time and owner/operation/target come from the broker.
  report(incident: IncidentReport): Outcome<null>;
  target?: TargetRef;
  // Rechecked after approval/queueing; use these, not unchecked input paths.
  paths: readonly string[];
}
export interface ExecutionResult {
  outcome: Outcome;
  frames?: readonly Frame[];
  presentations?: readonly PresentationSummary[];
}
export interface AutomationTool {
  name: string;
  description: string;
  family: 'browser' | 'computer' | 'panel';
  inputSchema: z.ZodObject;
  availability: Availability;
  maxArgumentBytes?: number;
  plan(args: Readonly<Record<string, unknown>>, owner: string): ExecutionPlan;
  execute(
    args: Readonly<Record<string, unknown>>,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;
}

// Stable semantic request identity, bounded before validation, with no executable/toJSON values.
export function requestKey(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Request nesting limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item: unknown) => requestKey(item, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Expected JSON.');
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a === b ? 0 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${requestKey(item, depth + 1)}`)
    .join(',')}}`;
}
export function isJson(value: unknown): value is JsonValue {
  try {
    return Buffer.byteLength(requestKey(value), 'utf8') <= AUTOMATION_RESULT_LIMITS.jsonBytes;
  } catch {
    return false;
  }
}

export function validResult(result: ExecutionResult, target?: TargetRef): boolean {
  if (!isJson(result.outcome) || !isJson(result.presentations ?? [])) return false;
  if ((result.presentations ?? []).some((p) => p.items.length < 1 || p.items.length > 4))
    return false;
  const frames = result.frames ?? [];
  if (
    frames.length > 4 ||
    frames.reduce((n, f) => n + f.image.data.length, 0) > AUTOMATION_RESULT_LIMITS.imageBase64Bytes
  )
    return false;
  return frames.every((frame) => {
    const { image, imageSize, viewport } = frame;
    return (
      frame.target.id === target?.id &&
      frame.target.generation === target.generation &&
      frame.target.kind === target.kind &&
      frame.observationId.length > 0 &&
      frame.observationId.length <= 128 &&
      Number.isFinite(frame.capturedAt) &&
      frame.capturedAt >= 0 &&
      Number.isSafeInteger(frame.geometryGeneration) &&
      frame.geometryGeneration >= 0 &&
      (frame.documentGeneration === null ||
        (Number.isSafeInteger(frame.documentGeneration) && frame.documentGeneration >= 0)) &&
      [imageSize.width, imageSize.height].every(
        (n) => Number.isInteger(n) && n > 0 && n <= AUTOMATION_RESULT_LIMITS.imageEdge,
      ) &&
      [viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) &&
      viewport.width > 0 &&
      viewport.height > 0 &&
      validTransform(frame.imageToViewport) &&
      image.data.length > 0 &&
      image.data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(image.data) &&
      imageTypeOf(image.data) === image.mediaType
    );
  });
}

function validTransform(values: readonly number[]): boolean {
  return values.length === 6 && values.every(Number.isFinite);
}
