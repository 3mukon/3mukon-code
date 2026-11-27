import { z } from 'zod';
import {
  NativeComputer,
  NATIVE_BACKEND,
  type ControlSurface,
  type ComputerResources,
} from '../../computer/main/computer';
import type { NativeHelper } from '../../computer/main/helper';
import {
  foregroundAction,
  nativeAction,
  type NativeAction,
} from '../../computer/main/native-protocol';
import type { TargetRef, Outcome } from '../../sessions/shared/automation';
import type { AutomationBroker } from '../../toolset/main/broker';
import type { AutomationTool, ExecutionContext, ExecutionPlan } from '../../toolset/main/execution';
import type { ComputerCommand } from '../../computer/shared/computer';

const ref = { id: z.uuid(), generation: z.int().positive() };
const application = z.strictObject({ ...ref, kind: z.literal('application') });
const window = z.strictObject({ ...ref, kind: z.literal('window') });
const metadata: ExecutionPlan = {
  operation: null,
  effect: 'metadata',
  delivery: 'background',
  mayActivate: false,
};
const cancelled = { status: 'cancelled-before-dispatch', effects: 'none' } as const;

function observe(target: TargetRef, requiresImages = false): ExecutionPlan {
  return {
    target,
    effect: 'observe',
    operation: 'application-background',
    delivery: 'background',
    mayActivate: false,
    requiresImages,
  };
}

function act(target: TargetRef, observationId: string, action: NativeAction): ExecutionPlan {
  const foreground = foregroundAction(action);
  return {
    target,
    observationId,
    requiresObservation: true,
    effect: 'mutate',
    operation: foreground ? 'application-foreground' : 'application-background',
    delivery: foreground ? 'foreground' : 'background',
    mayActivate: foreground || action.kind === 'click' || action.kind === 'window',
    // The app cannot enforce a file destination for arbitrary controls or synthesized keys.
    destinationKnown: !['click', 'point-click', 'drag', 'press'].includes(action.kind),
  };
}

function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  inputSchema: S,
  plan: (args: z.output<S>, owner: string) => ExecutionPlan,
  execute: (args: z.output<S>, context: ExecutionContext) => ReturnType<AutomationTool['execute']>,
): AutomationTool {
  return {
    name,
    description,
    inputSchema,
    family: 'computer',
    availability: { tools: 'ready', images: 'supported' },
    plan: (args, owner) => plan(inputSchema.parse(args), owner),
    execute: (args, context) => execute(inputSchema.parse(args), context),
  };
}

export function computerAutomation(
  helper: Pick<NativeHelper, 'runningApplications' | 'operate'>,
  getBroker: () => AutomationBroker,
  controlSurface?: ControlSurface,
) {
  const resources: ComputerResources = {
    register: (owner, item) =>
      getBroker().register(owner, {
        backend: NATIVE_BACKEND,
        key: item.key,
        kind: item.kind,
        mayActivate: true,
        summary: { name: item.name },
        application: item.application,
        release: () => item.release(),
      }),
    changed: (owner, ref, change) => {
      getBroker().targetChanged(owner, ref, change);
    },
    observation: (owner, ref) => getBroker().observation(owner, ref),
    ended: (owner, ref, reason, reportedBy) =>
      getBroker().targetEnded(owner, ref, reason, reportedBy),
    finish: (owner, ref) => getBroker().finishApplicationOperations(owner, ref),
  };
  const computer = new NativeComputer(helper, resources, controlSurface);
  function operation(context: ExecutionContext) {
    if (!context.operationId) throw Error('Native operation was not authorized.');
    return { id: context.operationId, callId: context.callId, signal: context.signal };
  }
  return {
    computer,
    command(owner: string, targetId: string, command: ComputerCommand): Promise<Outcome<null>> {
      const broker = getBroker();
      const ref = broker.resource(owner, targetId)?.ref;
      if (ref?.kind !== 'window')
        return Promise.resolve({ status: 'refused', code: 'stale-target', dispatched: false });
      if (command === 'reveal') return computer.reveal(owner, { ...ref, kind: 'window' });
      return Promise.resolve(
        command === 'take-over' ? broker.takeover(owner, ref) : broker.handBack(owner, ref),
      );
    },
    tools: [
      tool(
        'computer_targets',
        'List a bounded inventory of running macOS applications. Use the returned discovery ID with computer_select.',
        z.strictObject({}),
        () => metadata,
        async (_args, { owner, signal }) => ({ outcome: await computer.discover(owner, signal) }),
      ),
      tool(
        'computer_select',
        'Select a running application from computer_targets. Returns a session-owned application target. Discover again if it has exited or restarted.',
        z.strictObject({ id: z.uuid() }),
        () => metadata,
        async ({ id }, context) => {
          const outcome = await computer.select(context.owner, id, context.signal);
          if (outcome.status !== 'verified') return { outcome };
          context.names(outcome.value);
          return { outcome: { status: 'verified', value: { ...outcome.value } } };
        },
      ),
      tool(
        'computer_windows',
        'List standard windows of this application under its background operation grant. Returns session-owned window targets.',
        z.strictObject({ application }),
        (args) => observe(args.application),
        async (args, context) => ({
          outcome: await computer.windows(context.owner, args.application, operation(context)),
        }),
      ),
      tool(
        'computer_observe',
        'Read bounded Accessibility controls in one owned window. Set image to true for a window-only screenshot. Request a new observation after a window or control changes.',
        z.strictObject({ target: window, image: z.boolean().optional() }),
        ({ target, image }) => observe(target, image),
        ({ target, image }, context) =>
          computer.observe(context.owner, target, image ?? false, operation(context)),
      ),
      tool(
        'computer_act',
        'Use a fresh window observation. Click, type and scroll on supported Accessibility controls in the background. Point-click, point-scroll, drag and press require foreground control. Ask the user to focus the target window if needed. At workspace-write, click, point-click, drag and press are refused as file-scope-unverifiable, since the application decides which files they change; only the user can give the session full access, which an Antigravity session has in yolo alone. Point coordinates are screenshot pixels. Window changes must be explicit. An unverified dispatch does not establish the effect.',
        z.strictObject({ target: window, observationId: z.uuid(), action: nativeAction }),
        ({ target, observationId, action }, owner) => ({
          ...act(target, observationId, action),
          computerAction:
            action.kind === 'window'
              ? { kind: action.kind, change: action.change.kind }
              : 'element' in action
                ? {
                    kind: action.kind,
                    label: computer.actionLabel(owner, target, observationId, action.element),
                  }
                : { kind: action.kind },
        }),
        async ({ target, observationId, action }, context) => ({
          outcome: await computer.action(
            context.owner,
            target,
            observationId,
            action,
            operation(context),
            (event) => {
              const broker = getBroker();
              if (!broker.hasOwner(context.owner)) return;
              if (event === 'target-self-activated')
                context.report({ kind: 'target-self-activated', cause: 'unknown' });
              else if (!context.signal.aborted) {
                if (event === 'secure-input') {
                  context.report({ kind: 'secure-input', enabled: true });
                  broker.pauseForSecureInput(context.owner, target);
                } else broker.takeover(context.owner, target, 'unclassified-input');
              }
            },
          ),
        }),
      ),
      tool(
        'computer_release',
        'End this session’s operations on one application. The application and its windows stay open.',
        z.strictObject({ application }),
        () => metadata,
        (args, context) => {
          context.names(args.application);
          return Promise.resolve({
            outcome: context.signal.aborted
              ? cancelled
              : computer.release(context.owner, args.application),
          });
        },
      ),
    ],
  };
}
