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
import type { SessionAutomationHost, ToolsetAccess } from '../../sessions/main/provider';
import { AutomationBroker, type BrokerAccess } from './broker';
import { MAX_ARGUMENT_BYTES, type AutomationTool } from './execution';

export const TOOLSET_NAME = '3mukon-code';
const PATH = '/mcp';
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
  onOwnerRemoved,
  onDeliveryOpportunity,
}: {
  version: string;
  tools?: readonly AutomationTool[];
  onOwnerRemoved?: (id: string) => void;
  onDeliveryOpportunity?: () => void;
}): Promise<RunningToolset> {
  const broker = new AutomationBroker(tools);

  const descriptions: Tool[] = [
    {
      name: 'automation_capabilities',
      description:
        'Read this session’s cached automation capabilities and effective policy without starting a browser or native helper.',
      inputSchema: { type: 'object', properties: {} },
    },
    ...broker.definitions().map((tool) =>
      ToolSchema.parse({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          ...z.toJSONSchema(
            tool.inputSchema.extend({
              actionId: z
                .string()
                .min(1)
                .max(128)
                .describe(
                  'A unique ID for this action. Reuse it only for an immediate retry with the exact same arguments. Settled IDs have a bounded retention window; give each new action a new ID.',
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
    const credential = randomBytes(32).toString('base64url');
    const key = digest(credential);
    opened.set(key, access);
    credentialsByOwner.set(id, new Set([key]));
    return {
      url: `http://${host}${PATH}`,
      credential,
      generation: access.generation,
      tools: descriptions.map((tool) => tool.name),
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
          if (remove) onOwnerRemoved?.(id);
          if (remove && owns()) bindings.delete(id);
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
    const mcp = new McpServer({ name: TOOLSET_NAME, version });
    mcp.server.registerCapabilities({ tools: {} });
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => {
      broker.discovered(access);
      return { tools: descriptions };
    });
    // Validate feature arguments in the broker after allocating the call receipt, so even a bad
    // argument has an activity record. MCP still validates the protocol envelope through the SDK.
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      onDeliveryOpportunity?.();
      const name = request.params.name;
      if (name === 'automation_capabilities') {
        const capabilities = broker.capabilitiesFor(access);
        return {
          content: [{ type: 'text', text: JSON.stringify(capabilities) }],
          structuredContent: { ...capabilities },
        };
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
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(structured) },
            ...result.frames.map((frame) => ({
              type: 'image',
              mimeType: frame.image.mediaType,
              data: frame.image.data,
            })),
          ],
          structuredContent: structured,
          isError: result.outcome.status === 'refused' || result.outcome.status === 'indeterminate',
        };
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
