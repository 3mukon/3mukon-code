import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { PresentationHost } from '../../panels/main/presentation-host';
import { FakePresentationWindow } from '../../panels/shared/presentation-fake';
import { ARTIFACT_LIMITS, PRESENTATION_LIMITS } from '../../panels/shared/presentation';
import { panelTools } from '../../toolset/main/panel-tools';
import { startToolset, type RunningToolset } from '../../toolset/main/server';
import type { AutomationCallReceipt } from '../../sessions/shared/automation';
import type { ToolsetAccess } from '../../sessions/main/provider';

let service: RunningToolset;
let host: PresentationHost;
let window: FakePresentationWindow;
let access: ToolsetAccess;
let client: Client;
const cleanups: (() => Promise<unknown>)[] = [];
async function invokeTool(params: CallToolRequest['params']) {
  const send = client.callTool.bind(client);
  return CallToolResultSchema.parse(await send(params));
}
beforeEach(async () => {
  host = new PresentationHost({
    hasOwner: (id) => service.broker.hasOwner(id),
    file: (_owner, path) => Promise.resolve(path.startsWith('/allowed/') ? path : null),
    resource: () => null,
    notice: (owner, notice) => service.broker.recordPresentation(owner, notice),
  });
  const openedHost = host;
  cleanups.push(() => {
    openedHost.disconnect();
    return Promise.resolve();
  });
  service = await startToolset({
    version: 'test',
    tools: panelTools(host, { artifact: ARTIFACT_LIMITS, presentation: PRESENTATION_LIMITS }),
    onOwnerRemoved: (id) => {
      host.removeOwner(id);
    },
  });
  const openedService = service;
  cleanups.push(() => openedService.close());
  const binding = await service.sessions.bind({
    id: 'a',
    cwd: process.cwd(),
    mode: 'auto',
    sandbox: 'read-only',
  });
  binding.turnStarted();
  access = binding.toolset.open();
  host.connect((message) => {
    window.receive(message);
  });
  window = new FakePresentationWindow(
    (message) => {
      host.receive(message);
    },
    ['a'],
  );
  client = new Client({ name: 'synthetic', version: '0' });
  const openedClient = client;
  cleanups.splice(1, 0, () => openedClient.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(access.url), {
      requestInit: { headers: { Authorization: `Bearer ${access.credential}` } },
    }),
  );
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('discovers all five panel tools, waits for the window, and retires a notice only on its native receipt', async () => {
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
    'automation_capabilities',
    'panel_list',
    'panel_present',
    'panel_update',
    'panel_arrange',
    'panel_close',
  ]);
  expect(service.broker.snapshot('a').value.availability.tools).toBe('ready');
  const args = {
    actionId: 'show',
    reuseKey: 'result',
    version: 0,
    title: 'Synthetic result',
    items: [
      {
        kind: 'artifact',
        artifact: { format: 'markdown', title: 'Synthetic result', text: '# Result' },
      },
    ],
  };
  const shown = await invokeTool({ name: 'panel_present', arguments: args });
  expect(shown.structuredContent?.outcome).toMatchObject({ status: 'verified' });
  expect(service.broker.snapshot('a').value.pendingApprovals).toEqual([]);
  const record = service.broker.snapshot('a').value.recentCalls[0];
  if (record?.family !== 'panel') throw Error('Missing panel record');
  const p = record.presentations[0];
  if (!p) throw Error('Missing presentation');
  window.close(p.id);
  const listed = await invokeTool({ name: 'panel_list', arguments: { actionId: 'list' } });
  expect(listed.structuredContent?.outcome).toMatchObject({
    value: { presentations: [{ id: p.id, version: p.version + 1, items: [{ box: null }] }] },
  });
  expect(service.broker.snapshot('a').value.presentationNotices).toHaveLength(1);
  access.result?.(
    'panel_list',
    'native-entry',
    listed.structuredContent?.automation as AutomationCallReceipt,
  );
  expect(service.broker.snapshot('a').value.presentationNotices).toEqual([]);
  // A replay has its own activity receipt but reuses the outcome without presenting again.
  const again = await invokeTool({ name: 'panel_present', arguments: args });
  expect(again.structuredContent?.outcome).toEqual(shown.structuredContent?.outcome);
  expect(again.structuredContent?.automation).not.toEqual(shown.structuredContent?.automation);
  expect(
    (await invokeTool({ name: 'panel_list', arguments: { actionId: 'list-now' } }))
      .structuredContent?.outcome,
  ).toMatchObject({ value: { presentations: [{ items: [{ box: null }] }] } });
});

it('refuses terminal closing, forged fields, invalid artifacts and absent renderers with typed outcomes', async () => {
  const close = await invokeTool({
    name: 'panel_close',
    arguments: { actionId: 'terminal', target: 'terminal', presentationId: 'terminal', version: 0 },
  });
  expect(close.structuredContent?.outcome).toMatchObject({ code: 'invalid-request' });
  const terminalId = await invokeTool({
    name: 'panel_close',
    arguments: { actionId: 'unknown-presentation', presentationId: 'terminal', version: 0 },
  });
  expect(terminalId.structuredContent?.outcome).toMatchObject({ code: 'not-found' });
  const forged = await invokeTool({
    name: 'panel_list',
    arguments: { actionId: 'forged', owner: 'b' },
  });
  expect(forged.structuredContent?.outcome).toMatchObject({ code: 'invalid-request' });
  const invalid = await invokeTool({
    name: 'panel_present',
    arguments: {
      actionId: 'html',
      reuseKey: 'html',
      version: 0,
      title: 'No HTML',
      items: [
        {
          kind: 'artifact',
          artifact: { format: 'html', title: 'No HTML', text: '<script>bad()</script>' },
        },
      ],
    },
  });
  expect(invalid.structuredContent?.outcome).toMatchObject({ code: 'invalid-request' });
  host.disconnect();
  const absent = await invokeTool({
    name: 'panel_present',
    arguments: {
      actionId: 'absent',
      reuseKey: 'file',
      version: 0,
      title: 'File',
      items: [{ kind: 'file', path: '/allowed/file.md' }],
    },
  });
  expect(absent.structuredContent?.outcome).toMatchObject({ code: 'renderer-unavailable' });
});
