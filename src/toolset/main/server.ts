import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Toolset } from '../../sessions/main/provider';

// The toolset's name, as providers list it and as its MCP server introduces itself.
export const TOOLSET_NAME = '3mukon-code';

const PATH = '/mcp';

export interface RunningToolset extends Toolset {
  // Stops serving: every session's access ends.
  close(): Promise<void>;
}

// Serves the app's own MCP toolset (ADR-0012) over streamable HTTP on the loopback interface, at a
// port the system chooses. A request needs the credential of a session whose access is open. Each
// request gets an MCP server and transport of its own, as the MCP SDK's stateless mode has it.
export async function startToolset({ version }: { version: string }): Promise<RunningToolset> {
  // The digests of the open accesses' credentials, so that looking one up compares no credential
  // directly.
  const opened = new Set<string>();
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
    if (!opened.has(digest(bearer(request.headers.authorization)))) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      reply(response, 401, 'Unauthorized.');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      reply(response, 405, 'This toolset takes POST requests only.');
      return;
    }
    const mcp = toolset(version);
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
    open() {
      const credential = randomBytes(32).toString('base64url');
      const key = digest(credential);
      opened.add(key);
      return {
        url: `http://${host}${PATH}`,
        credential,
        close() {
          opened.delete(key);
        },
      };
    },
    close() {
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

// The toolset's MCP server for one request. It has no tools in this version, and lists none: Codex
// lists a server's tools even when it offers none, and a required server that cannot list them keeps
// Codex from starting a thread. The first tool registered with registerTool lists the tools itself, so
// these two lines go with it.
function toolset(version: string): McpServer {
  const mcp = new McpServer({ name: TOOLSET_NAME, version });
  mcp.server.registerCapabilities({ tools: {} });
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
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
