import { agent, type AnyMessage, type Stream } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGrokBuildProvider } from '../../src/providers/grok-build/main/adapter';
import type { ProviderSession } from '../../src/sessions/main/provider';
import type { PresentationNotice } from '../../src/sessions/shared/automation';
import type { SessionEvent } from '../../src/sessions/shared/events';
import { startToolset } from '../../src/toolset/main/server';

// The real adapter, HTTP toolset and broker, with only Grok's process replaced by an in-memory ACP
// agent. Its update sequence and native MCP result wrapper follow Grok Build 1.0.70. No model,
// provider binary, app window or personal settings run here.
it.each(['sanmukon-code', 'foreign'])(
  'links the presentation and retires its notice only for the native server %s',
  async (serverName) => {
    const notice: PresentationNotice = {
      noticeId: 'synthetic-notice',
      owner: 'synthetic-owner',
      reuseKey: 'result',
      presentation: {
        id: 'synthetic-presentation',
        version: 1,
        title: 'Synthetic result',
        items: [{ content: { kind: 'artifact', artifactId: 'synthetic-artifact' }, box: null }],
      },
    };
    const toolset = await startToolset({
      version: 'fixture',
      tools: [
        {
          name: 'panel_present',
          description: 'Present a synthetic result.',
          family: 'panel',
          inputSchema: z.object({}),
          availability: { tools: 'ready', images: 'unknown' },
          plan: () => ({
            operation: null,
            effect: 'present',
            delivery: 'background',
            mayActivate: false,
          }),
          execute: () =>
            Promise.resolve({
              outcome: { status: 'verified', value: null },
              presentations: [notice.presentation],
            }),
        },
      ],
    });
    const mcp = new Client({ name: 'synthetic-grok', version: '0' });
    let session: ProviderSession | undefined;
    const events: SessionEvent[] = [];
    const provider = createGrokBuildProvider({
      startGrok: (_cwd, args) => {
        expect(args).toContain('MCPTool(sanmukon-code__panel_present)');
        const toAgent = new TransformStream<AnyMessage, AnyMessage>();
        const toClient = new TransformStream<AnyMessage, AnyMessage>();
        const clientStream: Stream = { readable: toClient.readable, writable: toAgent.writable };
        const agentStream: Stream = { readable: toAgent.readable, writable: toClient.writable };
        let ended!: (reason: string | undefined) => void;
        const end = new Promise<string | undefined>((resolve) => {
          ended = resolve;
        });
        const connection = agent()
          .onRequest('initialize', () => ({
            protocolVersion: 1,
            authMethods: [],
            agentCapabilities: { mcpCapabilities: { http: true } },
          }))
          .onRequest('session/new', async ({ params }) => {
            const server = params.mcpServers[0];
            if (!server || !('type' in server) || server.type !== 'http')
              throw new Error('Expected the bound HTTP toolset.');
            // Grok's registry refuses a leading digit, even though the MCP connection succeeds.
            expect(server.name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
            expect(server.name).toBe('sanmukon-code');
            await mcp.connect(
              new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: {
                  headers: Object.fromEntries(
                    server.headers.map(({ name, value }) => [name, value]),
                  ),
                },
              }),
            );
            expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain(
              'panel_present',
            );
            return { sessionId: 'native-session' };
          })
          .onRequest('session/set_mode', () => ({}))
          .onRequest('session/prompt', async ({ client }) => {
            const identity = { sessionId: 'native-session', toolCallId: 'native-present' };
            const meta = {
              'x.ai/tool': {
                version: 1,
                name: 'use_tool',
                kind: 'use_tool',
                namespace: 'grok_build',
                label: 'Use Tool',
                read_only: false,
              },
            };
            await client.notify('session/update', {
              sessionId: identity.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: identity.toolCallId,
                title: 'use_tool',
                _meta: meta,
              },
            });
            await client.notify('session/update', {
              sessionId: identity.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: identity.toolCallId,
                title: 'sanmukon-code__panel_present',
                kind: 'other',
                _meta: meta,
              },
            });
            const result = await mcp.callTool({
              name: 'panel_present',
              arguments: { actionId: 'present' },
            });
            expect(result.isError).toBe(false);
            expect(result.structuredContent).toMatchObject({ presentationNotices: [notice] });
            expect(toolset.broker.snapshot(notice.owner).value.presentationNotices).toEqual([
              notice,
            ]);
            // Completion deliberately omits title, kind, metadata and content, as the native trace
            // does. Even a genuine receipt cannot make a foreign-server wrapper a host result.
            await client.notify('session/update', {
              sessionId: identity.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: identity.toolCallId,
                status: 'completed',
                rawOutput: {
                  type: 'MCP',
                  tool_name: 'panel_present',
                  server_name: serverName,
                  output: { OkayOutput: JSON.stringify(result.structuredContent) },
                },
              },
            });
            return { stopReason: 'end_turn' };
          })
          .connect(agentStream);
        return Promise.resolve({
          stream: clientStream,
          ended: end,
          stop() {
            connection.close();
            ended(undefined);
            return Promise.resolve();
          },
        });
      },
    });
    try {
      const owner = await toolset.sessions.bind({
        id: notice.owner,
        cwd: process.cwd(),
        mode: 'auto',
        sandbox: 'workspace-write',
      });
      toolset.broker.recordPresentation(notice.owner, notice);
      session = await provider.start({ cwd: process.cwd(), toolset: owner.toolset }, (event) => {
        if (event.type === 'turn-started') owner.turnStarted();
        if (event.type === 'turn-ended') owner.turnEnded();
        events.push(event);
      });
      await session.send('Present the synthetic result.');
      await vi.waitFor(() => {
        expect(events).toContainEqual({ type: 'turn-ended', outcome: 'completed' });
      });
      const snapshot = toolset.broker.snapshot(notice.owner).value;
      expect(snapshot.recentCalls).toHaveLength(1);
      expect(snapshot.recentCalls[0]).toMatchObject({
        family: 'panel',
        presentations: [notice.presentation],
      });
      if (serverName === 'sanmukon-code') {
        expect(snapshot.recentCalls[0]?.providerEntry).toMatchObject({
          providerToolId: 'native-present',
          toolName: 'panel_present',
          sessionId: notice.owner,
        });
        expect(snapshot.presentationNotices).toEqual([]);
      } else {
        expect(snapshot.recentCalls[0]?.providerEntry).toBeNull();
        expect(snapshot.presentationNotices).toEqual([notice]);
      }
    } finally {
      await session?.close();
      await provider.close();
      await mcp.close();
      await toolset.close();
    }
  },
);
