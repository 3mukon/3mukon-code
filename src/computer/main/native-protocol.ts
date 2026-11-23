import { z } from 'zod';
import type { ControlWindowButton } from '../shared/computer';

export const NATIVE_WIRE_VERSION = 7;
export const NATIVE_REQUEST_BYTES = 16 * 1024;
export const NATIVE_CONTROL_BYTES = 544 * 1024;
export const NATIVE_IMAGE_BASE64 = 1024 * 1024;
export const NATIVE_FRAME_BYTES = NATIVE_IMAGE_BASE64 + 32 * 1024;

const positive = z.int().positive();
const bundleId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9.-]+$/);
const label = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}]+$/u);
const handle = z.uuid();
export const nativeApplication = z.strictObject({
  pid: positive.max(2_147_483_647),
  startedAt: positive,
  processStart: z.string().regex(/^[1-9][0-9]{0,19}$/),
  bundleId,
});
const application = nativeApplication.extend({ name: label });
export type NativeApplication = z.infer<typeof nativeApplication>;
const permission = z.enum(['accessibility', 'screen-recording', 'input-monitoring']);
export type NativePermission = z.infer<typeof permission>;

const bounds = z.strictObject({
  x: z.number().min(-100_000).max(100_000),
  y: z.number().min(-100_000).max(100_000),
  width: z.number().positive().max(32_768),
  height: z.number().positive().max(32_768),
});
const window = z.strictObject({ id: handle, title: label, bounds, minimized: z.boolean() });
const element = z.strictObject({
  id: positive.max(48),
  role: label,
  label: label.optional(),
  bounds: bounds.optional(),
  actions: z.array(z.enum(['click', 'type', 'scroll'])).max(3),
});
const image = z.strictObject({
  mediaType: z.enum(['image/png', 'image/jpeg']),
  data: z
    .string()
    .min(1)
    .max(NATIVE_IMAGE_BASE64)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  width: positive.max(2048),
  height: positive.max(2048),
  capturedAt: positive,
});
const observation = z.strictObject({
  id: handle,
  bounds,
  elements: z.array(element).max(48),
  truncated: z.boolean(),
  image: image.optional(),
});
const previewImage = image.extend({ width: positive.max(768), height: positive.max(768) });

export const nativePoint = z.strictObject({
  x: z.number().min(0).max(2048),
  y: z.number().min(0).max(2048),
});
const control = positive.max(48);
const key = z.enum([
  'left',
  'right',
  'up',
  'down',
  'escape',
  'tab',
  'space',
  'return',
  'backspace',
  'home',
  'end',
  'page-up',
  'page-down',
]);
const windowChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('minimize') }),
  z.strictObject({ kind: z.literal('restore') }),
  z.strictObject({ kind: z.literal('move'), x: bounds.shape.x, y: bounds.shape.y }),
  z.strictObject({
    kind: z.literal('resize'),
    width: bounds.shape.width,
    height: bounds.shape.height,
  }),
]);
export const nativeAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), element: control }),
  z.strictObject({
    kind: z.literal('type'),
    element: control,
    text: z
      .string()
      .max(1000)
      .refine((s) => !s.includes('\0')),
  }),
  z.strictObject({
    kind: z.literal('scroll'),
    element: control,
    direction: z.enum(['up', 'down']),
  }),
  z.strictObject({ kind: z.literal('point-click'), point: nativePoint }),
  z.strictObject({
    kind: z.literal('point-scroll'),
    point: nativePoint,
    deltaY: z.int().min(-800).max(800),
  }),
  z.strictObject({ kind: z.literal('drag'), from: nativePoint, to: nativePoint }),
  z.strictObject({ kind: z.literal('press'), key, holdMs: z.int().min(0).max(1000).optional() }),
  z.strictObject({ kind: z.literal('window'), change: windowChange }),
]);
export type NativeAction = z.infer<typeof nativeAction>;

export function foregroundAction(action: NativeAction): boolean {
  return ['point-click', 'point-scroll', 'drag', 'press'].includes(action.kind);
}

// The foreground control's picture, which the helper keeps above the window it is about, and what
// each button that takes a click looks like under the pointer and pressed.
export interface NativeControlFrame {
  image: string;
  window: string;
  size: { width: number; height: number };
  buttons: readonly (ControlWindowButton & { hover?: string; pressed?: string })[];
}

// These packets are assembled in main from trusted broker facts and private OS identities.
export type HelperCommand =
  | { kind: 'hello' | 'permissions' | 'applications' }
  | { kind: 'request-permission'; permission: NativePermission }
  | { kind: 'application'; application: NativeApplication }
  | { kind: 'windows'; application: NativeApplication; operation: string; deadline: number }
  | {
      kind: 'preview';
      application: NativeApplication;
      window: string;
      operation: string;
      deadline: number;
    }
  | { kind: 'reveal'; window: string; operation: string; deadline: number }
  | {
      kind: 'observe';
      window: string;
      scope: string;
      image: boolean;
      operation: string;
      deadline: number;
    }
  | {
      kind: 'action';
      window: string;
      scope: string;
      observation: string;
      action: NativeAction;
      controlRevision?: number;
      operation: string;
      deadline: number;
    };
export type HelperRequest = HelperCommand['kind'];

const header = { version: z.literal(NATIVE_WIRE_VERSION), generation: handle, id: positive };
const failed = z.strictObject({
  status: z.literal('refused'),
  code: z.enum([
    'stale-target',
    'stale-observation',
    'setup-required',
    'background-unavailable',
    'busy',
    'needs-user-action',
  ]),
  permission: permission.optional(),
});
const cancelled = z.strictObject({ status: z.literal('cancelled-before-dispatch') });
function reply<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('verified'), value }),
    failed,
    cancelled,
  ]);
}
const actionReply = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('verified'), value: z.null() }),
  failed,
  cancelled,
  z.strictObject({ status: z.literal('dispatched') }),
  z.strictObject({
    status: z.literal('indeterminate'),
    reason: z.enum(['cancelled-after-dispatch', 'timeout', 'backend-lost']),
  }),
]);

export const helperResponse = z.discriminatedUnion('kind', [
  z.strictObject({
    ...header,
    kind: z.literal('hello'),
    pid: positive,
    stopShortcut: z.boolean(),
  }),
  z.strictObject({
    ...header,
    kind: z.literal('permissions'),
    permissions: z.strictObject({
      accessibility: z.boolean(),
      screenRecording: z.boolean(),
      inputMonitoring: z.boolean(),
    }),
  }),
  z.strictObject({ ...header, kind: z.literal('request-permission'), prompted: z.boolean() }),
  z.strictObject({
    ...header,
    kind: z.literal('applications'),
    inventory: z.strictObject({
      applications: z.array(application).max(64),
      truncated: z.boolean(),
    }),
  }),
  z.strictObject({ ...header, kind: z.literal('application'), result: reply(z.null()) }),
  z.strictObject({
    ...header,
    kind: z.literal('windows'),
    result: reply(z.strictObject({ windows: z.array(window).max(16), truncated: z.boolean() })),
  }),
  z.strictObject({ ...header, kind: z.literal('observe'), result: reply(observation) }),
  z.strictObject({
    ...header,
    kind: z.literal('preview'),
    result: reply(
      z.union([
        z.strictObject({ frame: z.strictObject({ id: handle, bounds, image: previewImage }) }),
        z.strictObject({
          reason: z.enum(['application-quit', 'permission-required', 'target-state-unsupported']),
        }),
      ]),
    ),
  }),
  z.strictObject({ ...header, kind: z.literal('reveal'), result: actionReply }),
  z.strictObject({ ...header, kind: z.literal('action'), result: actionReply }),
]);
export const helperEvent = z.strictObject({
  ...header,
  kind: z.literal('event'),
  event: z.enum(['takeover', 'secure-input', 'target-self-activated']),
});
export const helperControlCommand = z.strictObject({
  ...header,
  kind: z.literal('control-command'),
  event: z.enum(['stop', 'hand-back', 'shortcut']),
});
export type NativeEvent = z.infer<typeof helperEvent>['event'];
export type HelperResponse = z.infer<typeof helperResponse>;
export type HelperReply<T extends HelperRequest> = Extract<HelperResponse, { kind: T }>;
export type NativeWindow = z.infer<typeof window>;
export type NativeObservation = z.infer<typeof observation>;
