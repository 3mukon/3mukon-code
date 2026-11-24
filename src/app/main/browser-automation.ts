import { z } from 'zod';
import type { ChromeProfileConnection } from '../../browser/main/chrome-profile';
import {
  EmbeddedBrowser,
  type BrowserIncident,
  type BrowserResources,
} from '../../browser/main/embedded';
import { displayAddress, webAddress, type EmbeddedEngine } from '../../browser/main/page';
import { SCRIPT_LIMITS } from '../../browser/main/page-script';
import type { BrowserTabRef } from '../../browser/shared/browser';
import type { AutomationBroker } from '../../toolset/main/broker';
import type { AutomationTool, ExecutionContext, ExecutionPlan } from '../../toolset/main/execution';

const target = z.strictObject({
  kind: z.literal('browser-tab'),
  id: z.uuid(),
  generation: z.int().positive(),
});
const url = z
  .string()
  .max(4096)
  .refine((value) => webAddress(value) !== null, {
    message: 'Use an HTTP or HTTPS URL without embedded credentials.',
  });
const element = z.int().min(1).max(64);
const script = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= SCRIPT_LIMITS.sourceBytes, {
    message: 'Keep the script within 32 KiB.',
  });
const action = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), element }),
  z.strictObject({ kind: z.literal('type'), element, text: z.string().max(4096) }),
  z.strictObject({ kind: z.literal('scroll'), deltaY: z.int().min(-4000).max(4000) }),
]);
const metadata: ExecutionPlan = {
  operation: null,
  effect: 'metadata',
  delivery: 'background',
  mayActivate: false,
};
function tabPlan(
  ref: BrowserTabRef,
  effect: 'observe' | 'navigate' | 'mutate',
  inPanel: boolean,
): ExecutionPlan {
  return {
    target: ref,
    operation: 'browser-tab',
    effect,
    delivery: 'background',
    mayActivate: false,
    ...(inPanel ? { inPanel: true } : {}),
  };
}
function define<S extends z.ZodObject>(
  name: string,
  description: string,
  inputSchema: S,
  plan: (args: z.output<S>, owner: string) => ExecutionPlan,
  execute: (args: z.output<S>, context: ExecutionContext) => ReturnType<AutomationTool['execute']>,
): AutomationTool {
  return {
    name,
    family: 'browser',
    description,
    inputSchema,
    availability: { tools: 'ready', images: 'supported' },
    plan: (args, owner) => plan(inputSchema.parse(args), owner),
    execute: (args, context) => execute(inputSchema.parse(args), context),
  };
}
function incidents(context: ExecutionContext) {
  return (incident: BrowserIncident) => {
    if (incident === 'popup-activated' || incident === 'target-activated') {
      context.report({
        kind: 'target-self-activated',
        cause: incident === 'popup-activated' ? 'popup' : 'unknown',
      });
    } else {
      context.report({ kind: 'dialog-dismissed', dialog: incident });
    }
  };
}

// Whether a panel of the session shows its tab, which a call records as it is made.
type InPanel = (owner: string, tab: BrowserTabRef) => boolean;

export function embeddedBrowser(
  engine: EmbeddedEngine,
  getBroker: () => AutomationBroker,
  chrome?: ChromeBrowser,
  inPanel: InPanel = () => false,
) {
  const resources: BrowserResources = {
    register: (owner, spec) => getBroker().register(owner, spec),
    changed: (owner, tab, change) => {
      getBroker().targetChanged(owner, tab, change);
    },
    describe: (owner, tab, name, address) => {
      getBroker().describeBrowserTab(owner, tab, name, address);
    },
    observation: (owner, tab) => getBroker().observation(owner, tab),
    ended: (owner, tab, reason) => getBroker().targetEnded(owner, tab, reason),
    takeover: (owner, tab) => getBroker().takeover(owner, tab),
    handBack: (owner, tab) => getBroker().handBack(owner, tab),
  };
  const browser = new EmbeddedBrowser(engine, resources);
  return { browser, tools: browserTools(browser, chrome, inPanel) };
}

type ChromeBrowser = Pick<ChromeProfileConnection, 'liveTab' | 'requirement'>;
const chromeSetup = {
  kind: 'setup',
  requirement: { kind: 'browser', browser: 'chrome', step: 'connect' },
} as const;

export function browserTools(
  browser: EmbeddedBrowser,
  chrome?: ChromeBrowser,
  inPanel: InPanel = () => false,
): AutomationTool[] {
  return [
    define(
      'browser_open',
      "Reserve a browser tab. Prefer the app's own browser. Use none for isolated work, app for the shared app profile's sign-ins, or global for the connected Chrome profile. Use browser_navigate to open the task URL. Each shared tab has its own operation grant.",
      z.strictObject({ sharing: z.enum(['none', 'app', 'global']).optional() }),
      ({ sharing }) => {
        const setup = sharing === 'global' ? chrome?.requirement() : undefined;
        return setup ? { ...metadata, setup } : metadata;
      },
      async ({ sharing }, { owner, signal }) => {
        // A saved connection that is coming back, as after the app starts, is waited for.
        const connected = sharing === 'global' ? await chrome?.liveTab(signal) : undefined;
        if (signal.aborted)
          return { outcome: { status: 'cancelled-before-dispatch', effects: 'none' } };
        // No connection came back: Chrome needs the user, as the session's setup notice says.
        if (sharing === 'global' && chrome && !connected)
          return {
            outcome: {
              status: 'refused',
              code: 'setup-required',
              dispatched: false,
              detail: chromeSetup,
            },
          };
        const outcome = browser.open(owner, sharing ?? 'none', signal, connected ?? undefined);
        return {
          outcome:
            outcome.status === 'verified'
              ? { status: 'verified', value: { ...outcome.value } }
              : outcome,
        };
      },
    ),
    define(
      'browser_navigate',
      'Open an HTTP or HTTPS address without showing a panel. The final document can differ after redirection. Use browser_snapshot to check it.',
      z.strictObject({ target, url }),
      ({ target, url }, owner) => ({
        ...tabPlan(target, 'navigate', inPanel(owner, target)),
        mayActivate: browser.isExternal(owner, target),
        browserAddress: displayAddress(url) ?? undefined,
      }),
      async ({ target, url }, context) => ({
        outcome: await browser.navigate(
          context.owner,
          target,
          url,
          context.signal,
          incidents(context),
        ),
      }),
    ),
    define(
      'browser_snapshot',
      'Read a bounded semantic snapshot of the top-level document in an owned tab. Element references belong to this observation and expire when the page or view changes.',
      z.strictObject({ target }),
      ({ target }, owner) => tabPlan(target, 'observe', inPanel(owner, target)),
      async ({ target }, context) => {
        const outcome = await browser.observe(
          context.owner,
          target,
          context.signal,
          incidents(context),
        );
        return {
          outcome:
            outcome.status === 'verified'
              ? { status: 'verified', value: { ...outcome.value } }
              : outcome,
        };
      },
    ),
    define(
      'browser_screenshot',
      'Capture a bounded screenshot of an owned tab’s current viewport without bringing it forward.',
      z.strictObject({ target }),
      ({ target }, owner) => ({
        ...tabPlan(target, 'observe', inPanel(owner, target)),
        requiresImages: true,
      }),
      async ({ target }, context) => {
        const frame = await browser.capture(
          context.owner,
          target,
          context.signal,
          incidents(context),
        );
        return frame.status === 'verified'
          ? { outcome: { status: 'verified', value: null }, frames: [frame.value] }
          : { outcome: frame };
      },
    ),
    define(
      'browser_act',
      'Click a visible control, replace an editable text field’s contents, or scroll the top-level page. Use an element reference from the latest browser_snapshot. Take a fresh snapshot after each action. A dispatched result does not verify what the site did.',
      z.strictObject({ target, observationId: z.uuid(), action }),
      ({ target, observationId, action }, owner) => ({
        ...tabPlan(target, 'mutate', inPanel(owner, target)),
        mayActivate: browser.isExternal(owner, target),
        observationId,
        requiresObservation: true,
        browserAction:
          action.kind === 'scroll'
            ? { kind: action.kind }
            : {
                kind: action.kind,
                label: browser.actionLabel(owner, target, observationId, action.element),
              },
      }),
      async ({ target, observationId, action }, context) => ({
        outcome: await browser.action(
          context.owner,
          target,
          observationId,
          action,
          context.signal,
          incidents(context),
        ),
      }),
    ),
    define(
      'browser_evaluate',
      "Run a script in an owned tab's top-level document, in the page's own context, as the browser's developer console runs what is typed into it: its last expression is its value, it may await at its top level, and a promise it ends with is awaited. Returns the value as JSON, cut at 32 KiB, or the error it threw. It runs for 10 seconds unless timeoutMs asks for up to 30, then it is stopped. A script makes element references stale: take a fresh browser_snapshot before the next browser_act. In a tab with shared sign-ins it reads what the page can, so use it only for the task. Refused at read-only.",
      z.strictObject({
        target,
        script,
        timeoutMs: z.int().min(100).max(SCRIPT_LIMITS.maxMs).optional(),
      }),
      ({ target, script }, owner) => ({
        ...tabPlan(target, 'mutate', inPanel(owner, target)),
        mayActivate: browser.isExternal(owner, target),
        browserAction: { kind: 'script', script },
      }),
      async ({ target, script, timeoutMs }, context) => {
        const outcome = await browser.runScript(
          context.owner,
          target,
          script,
          timeoutMs ?? SCRIPT_LIMITS.defaultMs,
          context.signal,
          incidents(context),
        );
        return {
          outcome:
            outcome.status === 'verified'
              ? { status: 'verified', value: { ...outcome.value } }
              : outcome,
        };
      },
    ),
    define(
      'browser_close',
      'Release a session tab and its operation. Tabs created for the session close. External tabs already open before the session or handed to the user stay open.',
      z.strictObject({ target }),
      () => metadata,
      async ({ target }, { owner, signal }) => ({
        outcome: signal.aborted
          ? { status: 'cancelled-before-dispatch', effects: 'none' }
          : await browser.closeTab(owner, target),
      }),
    ),
  ];
}
