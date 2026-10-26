import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CancelledNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Toolset, ToolsetSession } from '../../sessions/main/provider';
import {
  ASK_USER,
  askUserDescription,
  askUserInput,
  askUserOutput,
  toQuestions,
  toResult,
} from './ask-user';

// The toolset's name, as providers list it and as its MCP server introduces itself.
export const TOOLSET_NAME = '3mukon-code';

const PATH = '/mcp';

export interface RunningToolset extends Toolset {
  // Stops serving: every session's access ends, and calls still running end as cancelled.
  close(): Promise<void>;
}

// One session's access while it lasts.
interface Opened {
  session: ToolsetSession;
  // Aborts the session's running calls when its access ends.
  ended: AbortController;
  // The session's running calls, by their request ids. A provider that gives up a call says so in a
  // request of its own, which a server of its own handles, so the calls are found here.
  calls: Map<string, AbortController>;
}

// Serves the app's own MCP toolset (ADR-0009) over streamable HTTP on the loopback interface, at a
// port the system chooses. A request needs the credential of a session whose access is open, and its
// calls act for that session alone. Each request gets an MCP server and transport of its own, as the
// MCP SDK's stateless mode has it, so a call can wait for the user as long as its request lasts.
export async function startToolset({ version }: { version: string }): Promise<RunningToolset> {
  // By the digest of each credential, so that looking one up compares no credential directly.
  const opened = new Map<string, Opened>();
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

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (new URL(request.url ?? '/', `http://${host}`).pathname !== PATH) {
      reply(response, 404, 'Not found.');
      return;
    }
    // Only a local client that names this address may connect, never a web page: a page's request
    // carries an Origin, and one through a rebound name carries another Host.
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      reply(response, 403, 'Forbidden.');
      return;
    }
    const entry = opened.get(digest(bearer(request.headers.authorization)));
    if (entry === undefined) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      reply(response, 401, 'Unauthorized.');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      reply(response, 405, 'This toolset takes POST requests only.');
      return;
    }
    const mcp = toolset(entry, version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
    open(session) {
      const credential = randomBytes(32).toString('base64url');
      const key = digest(credential);
      const entry: Opened = { session, ended: new AbortController(), calls: new Map() };
      opened.set(key, entry);
      return {
        url: `http://${host}${PATH}`,
        credential,
        close() {
          if (opened.get(key) !== entry) return;
          opened.delete(key);
          entry.ended.abort();
        },
      };
    },
    close() {
      for (const entry of opened.values()) entry.ended.abort();
      opened.clear();
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

// The toolset's MCP server for one request of one session.
function toolset(entry: Opened, version: string): McpServer {
  const mcp = new McpServer({ name: TOOLSET_NAME, version });
  mcp.server.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
    if (params.requestId !== undefined) entry.calls.get(String(params.requestId))?.abort();
  });
  mcp.registerTool(
    ASK_USER,
    {
      title: 'Ask the user',
      description: askUserDescription,
      inputSchema: askUserInput,
      outputSchema: askUserOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const questions = toQuestions(input);
      const id = String(extra.requestId);
      const call = new AbortController();
      entry.calls.set(id, call);
      try {
        const answer = await entry.session.ask(
          questions,
          AbortSignal.any([extra.signal, entry.ended.signal, call.signal]),
        );
        const result = toResult(questions, answer);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } finally {
        if (entry.calls.get(id) === call) entry.calls.delete(id);
      }
    },
  );
  return mcp;
}

function bearer(header: string | undefined): string {
  const match = /^Bearer (\S+)$/i.exec(header ?? '');
  return match?.[1] ?? '';
}

function digest(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

function reply(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}
