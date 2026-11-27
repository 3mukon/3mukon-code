import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ListToolsRequestSchema,
  type Tool,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  SessionAutomationHost,
  SessionCoordinator,
  ToolsetAccess,
} from '../../sessions/main/provider';
import {
  INBOX_TEXT_HEAD,
  inboxContext,
  senderWords,
  type InboxNotice,
} from '../../sessions/shared/inbox';
import type { HostApproval } from '../../sessions/shared/automation';
import { AutomationBroker, type BrokerAccess } from './broker';
import { MAX_ARGUMENT_BYTES, type AutomationTool } from './execution';
import { sessionTools } from './session-tools';
import { TOOLSET_NAME } from '../../sessions/shared/tools';

export { TOOLSET_NAME } from '../../sessions/shared/tools';
// How long the providers are told to wait on one of the toolset's calls: a day, which an approval
// waiting for the user's answer needs and the backends' own deadlines never come near.
export const TOOLSET_CALL_TIMEOUT_MS = 24 * 60 * 60_000;
const PATH = '/mcp';
// What every provider shows its agent of the toolset whatever it defers behind its tool search, which
// finds a tool by its name and description: a map of the tools by group and name, with when each group
// is the one to use, then what holds across several of them.
const instructions = [
  "These are the 3mukon-code app's tools. Where your provider lists tools only after a tool search, search by the names below.",
  'Sessions: to have another agent do part of the work, on any provider and model, such as Claude, GPT, Gemini or Grok, start a child session with session_start; provider_list shows which provider offers a model, and the id to give. Use them rather than a subagent of your own when the work needs another provider’s model, or a session the user can see and steer. A child session starts none of its own. session_list lists the user’s sessions, message_send sends one a message, message_read reads your inbox, and session_end ends a child. Messages, and the app’s reports on your children, reach you by themselves, waking you when you are idle: to wait for a child, end your turn rather than polling message_read or session_list.',
  'Panels: panel_present shows the user a result, a comparison, a decision or a handoff beside your session; panel_update, panel_arrange, panel_close and panel_list manage what you presented. Keep work in the background by default, and present only what the user needs to inspect, compare, decide on or take over.',
  "Websites: use the browser tools, from browser_open, which opens a tab at the address you give, and browser_navigate, for its later pages, to browser_snapshot, browser_act, browser_screenshot, browser_evaluate and browser_close. Prefer the app's own browser. Respect the user's requested browser, and ask if it is unavailable.",
  'Native macOS apps: use the computer tools, from computer_targets and computer_select to computer_windows, computer_observe, computer_act and computer_release. automation_capabilities says what browser use and computer use can do in this session.',
  "Shared sign-ins may be missing or expired, so do not assume a site is signed in: check that the page shows the user's account. When a page asks for a sign-in, never enter a password, code or other credential yourself: present the tab at once with panel_present, without asking first, then ask the user to sign in there and hand the tab back, and continue once they say they have. While the user has the tab, its tools refuse with target-paused.",
  'In auto mode the app requests approval once per operation on a shared or native target. Group related actions on that target within the same turn. A session grant applies to later operations on that target until it ends.',
  'Respect setup requirements, refusals and stopped operations. Ask before broadening sharing or switching identities after a refusal.',
].join(' ');
export interface RunningToolset {
  readonly name: string;
  readonly broker: AutomationBroker;
  readonly sessions: SessionAutomationHost;
  close(): Promise<void>;
}

// Only transport instances are per POST. Authority, work, cancellation and results live in the
// broker, which no unbound provider factory or model-supplied session ID can reach.
export async function startToolset({
  version,
  tools = [],
  onOwnerClosed,
  onOwnerRemoved,
  onDeliveryOpportunity,
  coordinator,
}: {
  version: string;
  tools?: readonly AutomationTool[];
  onOwnerClosed?: (id: string) => Promise<void>;
  onOwnerRemoved?: (id: string) => void;
  onDeliveryOpportunity?: () => void;
  // The sessions' coordination (ADR-0036), which app composition gives once the sessions exist;
  // without it no session tool is offered.
  coordinator?: () => SessionCoordinator | undefined;
}): Promise<RunningToolset> {
  const broker = new AutomationBroker(tools);
  const coordination = coordinator === undefined ? [] : sessionTools();
  const sessionDescriptions = new Map(
    coordination.map((tool) => [
      tool.name,
      ToolSchema.parse({
        name: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: { ...z.toJSONSchema(tool.inputSchema), type: 'object' },
      }),
    ]),
  );
  // Which session each access is bound to, by its object, which no model argument can name.
  const ownerOf = new WeakMap<BrokerAccess, string>();

  const descriptions: Tool[] = [
    {
      name: 'automation_capabilities',
      description:
        'Read what browser use and computer use can do in this session and the policy that applies to them, such as its sandbox level and whether each is set up, without starting a browser or the native helper: check it before using them when you are not sure they are available.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: 'object', properties: {} },
    },
    ...broker.definitions().map((tool) =>
      ToolSchema.parse({
        name: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: {
          ...z.toJSONSchema(
            tool.inputSchema.extend({
              actionId: z
                .string()
                .min(1)
                .max(128)
                .optional()
                .describe(
                  'Leave it out, unless you mean to repeat a change with the same arguments within this turn, which takes a new ID each time: without one, the same call again in a turn returns its first outcome.',
                ),
            }),
          ),
          type: 'object',
        },
      }),
    ),
  ];
  const opened = new Map<string, BrokerAccess>();
  const credentialsByOwner = new Map<string, Set<string>>();
  const pending = new Map<BrokerAccess, Map<string | number, AbortController>>();
  let closing = false;
  const bindings = new Map<string, { active: boolean }>();
  const server = createServer((request, response) => {
    void serve(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${String(port)}`;

  function forgetOwner(id: string): void {
    for (const key of credentialsByOwner.get(id) ?? []) {
      const access = opened.get(key);
      if (access) broker.revoke(access);
      opened.delete(key);
    }
    credentialsByOwner.delete(id);
  }
  function open(id: string): ToolsetAccess {
    if (closing) throw new Error('The toolset is closed.');
    forgetOwner(id);
    const access = broker.openAccess(id);
    ownerOf.set(access, id);
    const credential = randomBytes(32).toString('base64url');
    const key = digest(credential);
    opened.set(key, access);
    credentialsByOwner.set(id, new Set([key]));
    return {
      url: `http://${host}${PATH}`,
      credential,
      generation: access.generation,
      tools: [...descriptions.map((tool) => tool.name), ...sessionDescriptions.keys()],
      availability: (value) => {
        broker.providerAvailability(access, value);
      },
      result: (tool, entry, receipt) => {
        broker.providerResult(access, tool, entry, receipt);
      },
      close() {
        opened.delete(key);
        credentialsByOwner.get(id)?.delete(key);
        broker.revoke(access);
      },
    };
  }
  const sessions: SessionAutomationHost = {
    async bind({ id, cwd, mode, sandbox }) {
      await broker.bind(id, cwd, { mode, sandbox });
      forgetOwner(id);
      broker.endTurn(id);
      broker.disconnect(id);
      const binding = { active: true };
      bindings.set(id, binding);
      const owns = () => bindings.get(id) === binding;
      const active = () => owns() && binding.active && !closing;
      return {
        toolset: {
          name: TOOLSET_NAME,
          callTimeoutMs: TOOLSET_CALL_TIMEOUT_MS,
          open: () => {
            if (!active()) throw new Error('access-revoked');
            return open(id);
          },
        },
        turnStarted: () => {
          if (active()) broker.beginTurn(id);
        },
        turnEnded: () => {
          if (active()) broker.endTurn(id);
        },
        stop: (reason) => {
          if (active()) broker.stop(id, reason);
        },
        setPolicy: (policy) => {
          if (active()) broker.setPolicy(id, policy);
        },
        disconnect() {
          if (!owns()) return;
          binding.active = false;
          forgetOwner(id);
          broker.endTurn(id);
          broker.disconnect(id);
        },
        async close(remove) {
          if (!owns()) return;
          binding.active = false;
          forgetOwner(id);
          await broker.closeOwner(id, remove);
          if (owns()) {
            try {
              await onOwnerClosed?.(id);
            } catch {
              console.error('Session resource cleanup failed.');
            }
          }
          if (remove) onOwnerRemoved?.(id);
          if (remove && owns()) bindings.delete(id);
        },
        onWaiting(listener) {
          let since = oldestRequest(broker.snapshot(id).value.pendingApprovals);
          const stop = broker.subscribe(id, (envelope) => {
            if (envelope.value.kind !== 'state') return;
            const now = oldestRequest(envelope.value.state.pendingApprovals);
            if (now === since) return;
            since = now;
            listener(since);
          });
          listener(since);
          return stop;
        },
        prepareSend() {
          if (!active()) throw new Error('access-revoked');
          onDeliveryOpportunity?.();
          broker.beginTurn(id);
          const delivery = broker.prepareNotices(id);
          return {
            context: { presentationNotices: delivery.notices },
            accepted: (delivered) => {
              if (owns()) broker.noticesDelivered(id, delivery.id, true, delivered);
            },
            failed: () => {
              if (owns()) broker.noticesDelivered(id, delivery.id, false);
            },
          };
        },
        linkResult: (link) => {
          if (owns() && link.sessionId === id) broker.link(link);
        },
      };
    },
  };

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let path: string;
    try {
      path = new URL(request.url ?? '/', `http://${host}`).pathname;
    } catch {
      reply(response, 400, 'Invalid request.');
      return;
    }
    if (path !== PATH) {
      reply(response, 404, 'Not found.');
      return;
    }
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      reply(response, 403, 'Forbidden.');
      return;
    }
    const access = opened.get(digest(bearer(request.headers.authorization)));
    if (!access || !broker.active(access)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      reply(response, 401, 'Unauthorized.');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      reply(response, 405, 'This toolset takes POST requests only.');
      return;
    }
    const mcp = new McpServer({ name: TOOLSET_NAME, version }, { instructions });
    mcp.server.registerCapabilities({ tools: {} });
    const owner = ownerOf.get(access);
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => {
      broker.discovered(access);
      const sessions = coordinator?.();
      const offered =
        sessions === undefined || owner === undefined
          ? []
          : coordination.flatMap((tool) =>
              tool.offered?.(sessions, owner) === false
                ? []
                : [sessionDescriptions.get(tool.name) ?? []].flat(),
            );
      return { tools: [...descriptions, ...offered] };
    });
    // The notices of new messages the result carries (ADR-0036), told as the result goes.
    const withInbox = <Result extends { content: { type: string; text?: string }[] }>(
      result: Result,
      structured: Record<string, unknown>,
      json: boolean,
    ) => {
      const notice = owner === undefined ? undefined : coordinator?.()?.notices(owner);
      if (notice === undefined) return { ...result, structuredContent: structured };
      notice.told();
      const inbox = inboxBlock(notice.notices);
      const [first, ...rest] = result.content;
      const text = json
        ? JSON.stringify({ ...structured, inbox })
        : `${first?.text ?? ''}\n\n${inboxText(notice.notices)}`;
      return {
        ...result,
        content: [{ type: 'text', text }, ...rest],
        structuredContent: { ...structured, inbox },
      };
    };
    // Validate feature arguments in the broker after allocating the call receipt, so even a bad
    // argument has an activity record. MCP still validates the protocol envelope through the SDK.
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      onDeliveryOpportunity?.();
      const name = request.params.name;
      const sessionTool = coordination.find((tool) => tool.name === name);
      if (sessionTool !== undefined) {
        const sessions = coordinator?.();
        if (sessions === undefined || owner === undefined) throw new Error('Unknown tool.');
        if (sessionTool.offered?.(sessions, owner) === false) {
          return {
            content: [{ type: 'text', text: 'A child session cannot start sessions.' }],
            isError: true,
          };
        }
        const parsed = sessionTool.inputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: z.prettifyError(parsed.error) }],
            isError: true,
          };
        }
        try {
          const { text, structured } = await sessionTool.call(sessions, owner, parsed.data);
          return withInbox({ content: [{ type: 'text', text }] }, structured, false);
        } catch (error) {
          return {
            content: [
              { type: 'text', text: error instanceof Error ? error.message : String(error) },
            ],
            isError: true,
          };
        }
      }
      if (name === 'automation_capabilities') {
        const capabilities = broker.capabilitiesFor(access);
        return withInbox(
          { content: [{ type: 'text', text: JSON.stringify(capabilities) }] },
          { ...capabilities },
          true,
        );
      }
      if (!broker.definitions().some((tool) => tool.name === name))
        throw new Error('Unknown tool.');
      let requests = pending.get(access);
      if (!requests) {
        requests = new Map();
        pending.set(access, requests);
      }
      if (requests.has(extra.requestId)) throw new Error('request-conflict');
      const controller = new AbortController();
      requests.set(extra.requestId, controller);
      const { actionId, ...input } = request.params.arguments ?? {};
      try {
        const result = await broker.dispatch(access, name, input, {
          actionId,
          signal: AbortSignal.any([controller.signal, extra.signal]),
        });
        const frames = result.frames.map((frame) => ({
          target: frame.target,
          observationId: frame.observationId,
          documentGeneration: frame.documentGeneration,
          geometryGeneration: frame.geometryGeneration,
          capturedAt: frame.capturedAt,
          imageSize: frame.imageSize,
          viewport: frame.viewport,
          units: frame.units,
          imageToViewport: frame.imageToViewport,
        }));
        const structured = {
          automation: result.automation,
          outcome: result.outcome,
          presentationNotices: result.presentationNotices,
          frames,
          ...(result.dialogDismissals ? { dialogDismissals: result.dialogDismissals } : {}),
        };
        return withInbox(
          {
            content: [
              { type: 'text', text: JSON.stringify(structured) },
              ...result.frames.map((frame) => ({
                type: 'image',
                mimeType: frame.image.mediaType,
                data: frame.image.data,
              })),
            ],
            isError:
              result.outcome.status === 'refused' || result.outcome.status === 'indeterminate',
          },
          structured,
          true,
        );
      } finally {
        requests.delete(extra.requestId);
        if (!requests.size) pending.delete(access);
      }
    });
    // Stateless MCP transports receive cancellation on another POST. Never let its request-local
    // controller be the only way to stop work begun by the preceding instance.
    mcp.server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      const id = notification.params.requestId;
      if (id !== undefined) pending.get(access)?.get(id)?.abort('cancelled');
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      maxRequestBodySize: MAX_ARGUMENT_BYTES + 4096,
    });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) reply(response, 500, 'The toolset failed to handle the request.');
      else response.end();
    }
  }
  return {
    name: TOOLSET_NAME,
    broker,
    sessions,
    async close() {
      closing = true;
      opened.clear();
      credentialsByOwner.clear();
      for (const requests of pending.values())
        for (const controller of requests.values()) controller.abort('session-closed');
      await broker.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
function bearer(header: string | undefined): string {
  return /^Bearer (\S+)$/i.exec(header ?? '')?.[1] ?? '';
}
function digest(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}
function reply(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

// When the oldest of these approvals was asked for, or undefined where there is none.
function oldestRequest(approvals: readonly HostApproval[]): number | undefined {
  return approvals.reduce<number | undefined>(
    (first, approval) =>
      first === undefined || approval.requestedAt < first ? approval.requestedAt : first,
    undefined,
  );
}

// The notices as the inbox block gives them, for a structured result.
function inboxBlock(notices: readonly InboxNotice[]): unknown {
  return JSON.parse(inboxContext(notices) ?? '{}');
}

// The notices as lines after a session tool's text.
function inboxText(notices: readonly InboxNotice[]): string {
  return [
    INBOX_TEXT_HEAD,
    ...notices.map((notice) => `- ${notice.id}: ${senderWords(notice)}: ${notice.summary}`),
  ].join('\n');
}
