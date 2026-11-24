import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { embeddedBrowser } from '../../src/app/main/browser-automation';
import { waitForLocalChromeExtension } from '../../src/browser/main/chrome-local-setup';
import { ChromeProfileConnection } from '../../src/browser/main/chrome-profile';
import { chromeProfileConnection } from '../../src/browser/main/chrome-profile-installation';
import type { EmbeddedEngine } from '../../src/browser/main/page';
import { AutomationBroker, type BrokerAccess } from '../../src/toolset/main/broker';

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({ getSize: () => ({ width: 640, height: 480 }) }),
  },
}));

const name = { id: 'Profile 3', name: 'Synthetic Work' };
const build = 'fixture1';

function nativeBrowser(folder: string) {
  const socket = createConnection(join(folder, 'channel'));
  const received: unknown[] = [];
  let bytes = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4) {
      const length = bytes.readUInt32LE();
      if (bytes.length < length + 4) return;
      received.push(JSON.parse(bytes.subarray(4, length + 4).toString('utf8')));
      bytes = bytes.subarray(length + 4);
    }
  });
  return {
    socket,
    closed: once(socket, 'close'),
    send(message: object) {
      const body = Buffer.from(JSON.stringify(message));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(body.length);
      socket.write(Buffer.concat([prefix, body]));
    },
    async next(): Promise<unknown> {
      await vi.waitFor(() => {
        expect(received.length).toBeGreaterThan(0);
      });
      return received.shift();
    },
  };
}

it('keeps the confirmed profile across app and native-peer restart and rejects a revoked link', async () => {
  const folder = await mkdtemp('/private/tmp/chrome-profile-');
  const setup = Promise.withResolvers<string>();
  const ports = {
    profiles: vi.fn(() => Promise.resolve({ status: 'read' as const, profiles: [name] })),
    build,
    install: vi.fn(() => Promise.resolve()),
    renew: vi.fn(() => Promise.resolve()),
    openSetup: vi.fn((_id: string, ticket: string) => {
      setup.resolve(ticket);
      return Promise.resolve();
    }),
    activate: vi.fn(() => Promise.resolve()),
  };
  const sockets: Socket[] = [];
  let app = new ChromeProfileConnection(folder, ports);
  try {
    // An agent's Chrome tab waits on Connect until a connection is live, also while connecting.
    expect(app.requirement()).toEqual({ kind: 'browser', browser: 'chrome', step: 'connect' });
    const initial = app.connect(name.id);
    expect(app.requirement()).toEqual({ kind: 'browser', browser: 'chrome', step: 'connect' });
    const ticket = await Promise.race([
      setup.promise,
      initial.then(() => {
        throw new Error('Chrome setup ended before opening the test profile.');
      }),
    ]);
    expect(ports.openSetup).toHaveBeenCalledExactlyOnceWith(
      name.id,
      ticket,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const wrong = nativeBrowser(folder);
    sockets.push(wrong.socket);
    wrong.send({ kind: 'pair', ticket: randomBytes(32).toString('hex'), build });
    await wrong.closed;
    expect(app.profile()).toBeNull();

    const browser = nativeBrowser(folder);
    sockets.push(browser.socket);
    browser.send({ kind: 'pair', ticket, build });
    const offer = (await browser.next()) as { kind: string; proof: string };
    expect(offer.kind).toBe('paired');
    browser.send({ kind: 'pair-saved' });
    expect(await browser.next()).toEqual({ kind: 'ready' });
    expect(await initial).toEqual({ status: 'verified', value: null });
    expect(app.profile()).toEqual(name);
    expect(app.requirement()).toBeUndefined();
    const first = app.tab();
    expect(first).toMatchObject({ browser: 'chrome', profile: name });
    const released = vi.fn();
    first?.onEnd(released);

    browser.socket.destroy();
    await vi.waitFor(() => {
      expect(app.profile()).toBeNull();
    });
    expect(released).toHaveBeenCalledOnce();
    expect(app.rememberedProfile()).toEqual(name);
    // A saved connection that dropped comes back within the extension's retry period, so an agent's
    // tab waits for it rather than needing setup, also after the app starts again.
    expect(app.requirement()).toBeUndefined();
    app.close();
    app = new ChromeProfileConnection(folder, ports);
    expect(app.rememberedProfile()).toEqual(name);
    expect(app.requirement()).toBeUndefined();
    const coming = app.liveTab(new AbortController().signal);
    await vi.waitFor(async () => {
      expect((await lstat(join(folder, 'channel'))).isSocket()).toBe(true);
    });
    const restored = nativeBrowser(folder);
    sockets.push(restored.socket);
    restored.send({ kind: 'restore', proof: offer.proof, build });
    expect(await restored.next()).toEqual({ kind: 'ready' });
    expect(await coming).toMatchObject({ browser: 'chrome', profile: name });
    expect(app.profile()).toEqual(name);
    expect(app.requirement()).toBeUndefined();
    expect(ports.openSetup).toHaveBeenCalledOnce();

    const ended = app.disconnect(name.id);
    const request = (await restored.next()) as { id: number; action: object };
    expect(request.action).toEqual({ kind: 'forget' });
    restored.send({ kind: 'reply', id: request.id, ok: true });
    expect(await ended).toEqual({ status: 'verified', value: null });
    const revoked = nativeBrowser(folder);
    sockets.push(revoked.socket);
    revoked.send({ kind: 'restore', proof: offer.proof, build });
    await revoked.closed;
    expect(app.rememberedProfile()).toBeNull();
  } finally {
    app.close();
    for (const socket of sockets) socket.destroy();
    await rm(folder, { recursive: true, force: true });
  }
});

it('reads the profile names first, asks for the Chrome folder only after a refused read, and reads at once in an app that starts again', async () => {
  const folder = await mkdtemp('/private/tmp/chrome-names-');
  const browserData = join(folder, 'Chrome');
  const connection = () =>
    chromeProfileConnection({
      appData: join(folder, 'app'),
      browserData,
      browserBundle: join(folder, 'unused'),
      browserExecutable: join(folder, 'unused'),
      hostExecutable: join(folder, 'unused'),
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      bundledExtension: join(folder, 'unused'),
      build,
    });
  const app = connection();
  let restarted: ChromeProfileConnection | undefined;
  try {
    expect(await app.profiles()).toEqual({ status: 'read', profiles: [] });
    await mkdir(browserData);
    await writeFile(
      join(browserData, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 3': { name: name.name, unneeded: 'fixture' },
            Default: { missingDisplayName: true },
            'Guest Profile': { name: 'Guest' },
            '../elsewhere': { name: 'Not a profile' },
          },
        },
      }),
    );
    // What macOS's protection of Chrome's folder does to a read it refuses.
    await chmod(join(browserData, 'Local State'), 0o000);
    expect(await app.profiles()).toEqual({ status: 'access-required' });
    expect(await app.connect(name.id)).toMatchObject({
      status: 'refused',
      code: 'needs-user-action',
    });
    const cancel = vi.fn(() => Promise.resolve(undefined));
    expect(await app.allowProfileAccess(cancel)).toMatchObject({
      status: 'cancelled-before-dispatch',
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(browserData);
    expect(await app.allowProfileAccess(() => Promise.resolve(folder))).toMatchObject({
      status: 'refused',
      code: 'invalid-request',
    });
    expect(await app.profiles()).toEqual({ status: 'access-required' });
    expect(await app.allowProfileAccess((directory) => Promise.resolve(directory))).toEqual({
      status: 'verified',
      value: null,
    });
    // What macOS gives the app once the user selects the folder, which outlasts the app's process.
    await chmod(join(browserData, 'Local State'), 0o600);
    expect(await app.profiles()).toEqual({ status: 'read', profiles: [name] });
    restarted = connection();
    expect(await restarted.profiles()).toEqual({ status: 'read', profiles: [name] });
  } finally {
    app.close();
    restarted?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

it('waits for the local extension in the selected profile before opening its pairing page', async () => {
  const folder = await mkdtemp('/private/tmp/chrome-local-flow-');
  const browserData = join(folder, 'browser');
  const hostExecutable = join(folder, 'host-fixture');
  const browserExecutable = join(folder, 'browser-fixture');
  const bundledExtension = join(folder, 'bundled-extension');
  const extensionFolder = join(folder, 'app', 'chrome-link', 'extension');
  const trace = join(folder, 'launches');
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const launches = () => readFile(trace, 'utf8');
  const selector = '--profile-directory=' + name.id;
  const pairLine = `${selector}|chrome-extension://${extensionId}/pair.html\n`;
  const app = chromeProfileConnection({
    appData: join(folder, 'app'),
    browserData,
    browserBundle: join(folder, 'Synthetic Chrome.app'),
    browserExecutable,
    browserEnvironment: { CHROME_TRACE: trace },
    hostExecutable,
    extensionId,
    bundledExtension,
    build,
  });
  try {
    await mkdir(browserData);
    await mkdir(bundledExtension);
    await writeFile(join(bundledExtension, 'manifest.json'), '{}');
    await writeFile(join(bundledExtension, 'build.js'), `export const build = '${build}';\n`);
    await writeFile(
      join(browserData, 'Local State'),
      JSON.stringify({ profile: { info_cache: { [name.id]: { name: name.name } } } }),
    );
    await writeFile(hostExecutable, 'fixture', { mode: 0o700 });
    await writeFile(
      browserExecutable,
      '#!/bin/sh\nprintf "%s|%s\\n" "$2" "${3%%#*}" >> "$CHROME_TRACE"\n',
      { mode: 0o700 },
    );
    // A program starts in its own time on a busy Mac.
    const soon = { timeout: 5_000 };
    const connection = app.connect(name.id);
    let setupUrl = '';
    await vi.waitFor(async () => {
      const output = await launches();
      expect(output.startsWith(`${selector}|http://127.0.0.1:`)).toBe(true);
      setupUrl = output.trim().split('|')[1] ?? '';
    }, soon);
    const report = (status: string, origin = new URL(setupUrl).origin) =>
      fetch(setupUrl + '/' + status, { method: 'POST', headers: { origin } });
    expect((await report('ready', 'http://localhost')).status).toBe(404);
    expect((await report('missing')).status).toBe(204);
    const setupLines = `${selector}|${setupUrl}\n`;
    await vi.waitFor(async () => {
      expect(await launches()).toBe(setupLines);
      expect(app.extensionFolder()).toBe(extensionFolder);
    }, soon);
    expect(await readFile(join(extensionFolder, 'manifest.json'), 'utf8')).toBe('{}');
    expect((await report('ready')).status).toBe(204);
    await vi.waitFor(async () => {
      expect(await launches()).toBe(setupLines + pairLine);
    }, soon);
    expect(app.profile()).toBeNull();
    app.close();
    expect(await connection).toMatchObject({ status: 'refused' });
  } finally {
    app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

it('skips Chrome extension settings when the chosen profile already answers the local setup page', async () => {
  const controller = new AbortController();
  const open = vi.fn(async (url: string) => {
    const origin = new URL(url).origin;
    expect((await fetch(url)).ok).toBe(true);
    expect((await fetch(url + '/ready', { method: 'POST', headers: { origin } })).status).toBe(204);
  });
  const missing = vi.fn();
  await waitForLocalChromeExtension(
    { id: 'abcdefghijklmnopabcdefghijklmnop', build },
    open,
    missing,
    controller.signal,
  );
  expect(open).toHaveBeenCalledOnce();
  expect(missing).not.toHaveBeenCalled();
});

it('uses only inactive task tabs and rejects commands and cleanup of pre-existing tabs', async () => {
  const removed = vi.fn(() => Promise.resolve());
  const sendCommand = vi.fn(() => Promise.resolve(null));
  const updateSessionRules = vi.fn(() => Promise.resolve());
  const browser = {
    permissions: { contains: vi.fn(() => Promise.resolve(true)) },
    declarativeNetRequest: { updateSessionRules },
    windows: { getLastFocused: vi.fn(() => Promise.resolve({ id: 3, type: 'normal' })) },
    tabs: {
      create: vi.fn(() => Promise.resolve({ id: 19, incognito: false })),
      remove: removed,
    },
    debugger: { attach: vi.fn(() => Promise.resolve()), sendCommand },
  };
  const source = new URL('../../src/browser/native/chrome/extension/task-tabs.js', import.meta.url);
  const { TaskTabs } = (await import(source.href)) as {
    TaskTabs: new (
      api: typeof browser,
      emit: () => void,
    ) => {
      request(action: object): Promise<unknown>;
      event(tab: number, method: string, value: unknown): void;
      close(): Promise<void>;
    };
  };
  const emit = vi.fn();
  const tabs = new TaskTabs(browser, emit);
  await expect(tabs.request({ kind: 'close-tab', tab: 7 })).rejects.toThrow('outside');
  await expect(
    tabs.request({ kind: 'command', tab: 7, method: 'Runtime.evaluate', params: {} }),
  ).rejects.toThrow('outside');
  expect(removed).not.toHaveBeenCalled();
  expect(sendCommand).not.toHaveBeenCalled();
  expect(await tabs.request({ kind: 'create-tab' })).toEqual({ tab: 19 });
  expect(browser.tabs.create).toHaveBeenCalledExactlyOnceWith({
    windowId: 3,
    url: 'about:blank',
    active: false,
  });
  await expect(
    tabs.request({ kind: 'command', tab: 19, method: 'Target.getTargets' }),
  ).rejects.toThrow('Unsupported command');
  expect(sendCommand).toHaveBeenCalledWith({ tabId: 19 }, 'Fetch.enable', {
    patterns: [{ resourceType: 'Document', requestStage: 'Response' }],
  });
  expect(updateSessionRules).toHaveBeenCalledExactlyOnceWith({
    removeRuleIds: [19],
    addRules: [
      {
        id: 19,
        condition: { tabIds: [19], resourceTypes: ['main_frame', 'sub_frame'] },
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            {
              header: 'content-security-policy',
              operation: 'append',
              value: 'sandbox allow-same-origin allow-scripts allow-forms',
            },
          ],
        },
      },
    ],
  });
  const responseHeaders = [{ name: 'Content-Type', value: 'text/html' }];
  const response = { requestId: 'document', responseStatusCode: 200, responseHeaders };
  sendCommand.mockClear();
  tabs.event(7, 'Fetch.requestPaused', response);
  expect(sendCommand).not.toHaveBeenCalled();
  tabs.event(19, 'Fetch.requestPaused', response);
  expect(sendCommand).toHaveBeenCalledExactlyOnceWith({ tabId: 19 }, 'Fetch.continueRequest', {
    requestId: 'document',
  });
  expect(emit).not.toHaveBeenCalled();
  await tabs.close();
  expect(removed).toHaveBeenCalledExactlyOnceWith(19);
  expect(updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [19] });
});

// The app's extension on the native channel, answering each request for its task tab with `answer`.
function taskExtension(folder: string, answer: (action: TaskAction) => object | undefined) {
  const socket = createConnection(join(folder, 'channel'));
  const received: unknown[] = [];
  let bytes = Buffer.alloc(0);
  const send = (message: object) => {
    const body = Buffer.from(JSON.stringify(message));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    socket.write(Buffer.concat([prefix, body]));
  };
  socket.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4) {
      const length = bytes.readUInt32LE();
      if (bytes.length < length + 4) return;
      const message = JSON.parse(bytes.subarray(4, length + 4).toString('utf8')) as {
        kind: string;
        id?: number;
        action?: TaskAction;
      };
      bytes = bytes.subarray(length + 4);
      if (message.kind !== 'request' || !message.action) {
        received.push(message);
        continue;
      }
      const result = answer(message.action);
      send({ kind: 'reply', id: message.id, ok: true, ...(result ? { result } : {}) });
    }
  });
  return { socket, send, received };
}
type TaskAction =
  | { kind: 'create-tab' | 'forget' }
  | { kind: 'close-tab'; tab: number }
  | { kind: 'command'; tab: number; method: string; params: { url?: string; expression?: string } };

it('asks before the first use of a task tab in the connected profile, opens it on navigation, previews and reveals it, and ends it on disconnect', async () => {
  const folder = await mkdtemp('/private/tmp/chrome-task-');
  const ticket = Promise.withResolvers<string>();
  const ports = {
    profiles: vi.fn(() => Promise.resolve({ status: 'read' as const, profiles: [name] })),
    build,
    install: vi.fn(() => Promise.resolve()),
    renew: vi.fn(() => Promise.resolve()),
    openSetup: vi.fn((_id: string, value: string) => {
      ticket.resolve(value);
      return Promise.resolve();
    }),
    activate: vi.fn(() => Promise.resolve()),
  };
  const app = new ChromeProfileConnection(folder, ports);
  const embedded = { page: vi.fn(), clear: vi.fn() } satisfies EmbeddedEngine;
  const { browser, tools } = embeddedBrowser(embedded, () => broker, app);
  const broker = new AutomationBroker(tools);
  const actions: TaskAction[] = [];
  const onViewport = vi.fn<() => void>();
  let address = 'about:blank';
  const extension = { current: undefined as ReturnType<typeof taskExtension> | undefined };
  const answer = (action: TaskAction): object | undefined => {
    actions.push(action);
    if (action.kind === 'create-tab') return { tab: 19 };
    if (action.kind !== 'command') return undefined;
    const { expression = '', url } = action.params;
    switch (action.method) {
      case 'Target.getTargetInfo':
        return { targetInfo: { type: 'page', targetId: 'target' } };
      case 'Page.navigate':
        address = url ?? address;
        return {};
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'top', url: address } } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 4 };
      case 'Page.captureScreenshot':
        return { data: 'ZmFrZQ==' };
      case 'Runtime.evaluate': {
        const viewport = expression.endsWith('({"kind":"viewport"})');
        if (viewport) onViewport();
        const value = expression.includes('document.title.slice')
          ? { title: 'Fixture', address: address + '?private=query#detail' }
          : expression.startsWith('document.hasFocus()')
            ? true
            : viewport
              ? { width: 640, height: 480, x: 0, y: 0 }
              : {
                  width: 640,
                  height: 480,
                  text: 'Signed in as a synthetic fixture',
                  truncated: false,
                  elements: [],
                };
        return { result: { value } };
      }
      default:
        return {};
    }
  };
  let serial = 0;
  const call = (access: BrokerAccess, tool: string, args: object) =>
    broker.dispatch(access, 'browser_' + tool, args, { actionId: String(++serial) });
  const bind = async (id: string) => {
    await broker.bind(id, process.cwd(), { mode: 'auto', sandbox: 'workspace-write' });
    const access = broker.openAccess(id);
    broker.beginTurn(id);
    return access;
  };
  try {
    const a = await bind('a');
    const b = await bind('b');
    expect((await call(a, 'open', { sharing: 'global' })).outcome).toMatchObject({
      code: 'setup-required',
      detail: {
        kind: 'setup',
        requirement: { kind: 'browser', browser: 'chrome', step: 'connect' },
      },
    });
    expect(ports.openSetup).not.toHaveBeenCalled();

    const connecting = app.connect(name.id);
    const invitation = await ticket.promise;
    const chrome = taskExtension(folder, answer);
    extension.current = chrome;
    chrome.send({ kind: 'pair', ticket: invitation, build });
    await vi.waitFor(() => {
      expect(chrome.received).toContainEqual(expect.objectContaining({ kind: 'paired' }));
    });
    chrome.send({ kind: 'pair-saved' });
    expect(await connecting).toEqual({ status: 'verified', value: null });

    const opened = (await call(a, 'open', { sharing: 'global' })).outcome;
    if (opened.status !== 'verified') throw new Error('The task tab was not reserved.');
    const tab = z
      .object({ id: z.uuid(), generation: z.int(), kind: z.literal('browser-tab') })
      .parse(opened.value);
    expect(broker.snapshot('a').value.pendingApprovals).toEqual([]);
    expect(browser.pageForView('a', tab)).toBeNull();
    expect((await call(b, 'snapshot', { target: tab })).outcome).toMatchObject({
      code: 'wrong-owner',
    });

    // The first use asks; a blank task tab then serves nothing before its first navigation.
    const reading = call(a, 'snapshot', { target: tab });
    await vi.waitFor(() => {
      expect(broker.snapshot('a').value.pendingApprovals).toHaveLength(1);
    });
    const [approval] = broker.snapshot('a').value.pendingApprovals;
    if (!approval) throw new Error('The fixture did not ask.');
    expect(approval.target).toMatchObject({ sharing: 'global', browser: 'chrome', profile: name });
    broker.answer('a', approval.id, { decision: 'allow-once' });
    expect((await reading).outcome).toMatchObject({ code: 'not-found' });
    expect(actions).toEqual([]);

    expect(
      (await call(a, 'navigate', { target: tab, url: 'https://fixture.test/path' })).outcome,
    ).toMatchObject({ status: 'dispatched' });
    expect(actions[0]).toEqual({ kind: 'create-tab' });
    expect((await call(a, 'snapshot', { target: tab })).outcome).toMatchObject({
      status: 'verified',
      value: { text: 'Signed in as a synthetic fixture', address: 'https://fixture.test/path' },
    });
    // A script runs in the task tab's own context through the extension's debugger session.
    expect(
      (await call(a, 'evaluate', { target: tab, script: 'document.title' })).outcome,
    ).toMatchObject({ status: 'verified', value: { kind: 'value' } });
    expect(actions).toContainEqual({
      kind: 'command',
      tab: 19,
      method: 'Runtime.evaluate',
      params: {
        expression: 'document.title',
        replMode: true,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      },
    });

    const preview = browser.pageForView('a', tab);
    const signal = broker.browserObservationSignal('a', tab);
    if (!preview || !signal) throw new Error('The preview operation was not established.');
    expect(await preview.capture(signal)).toMatchObject({ width: 640, height: 480 });
    expect('mount' in preview).toBe(false);
    expect(ports.activate).not.toHaveBeenCalled();
    expect(await browser.command('a', tab, { kind: 'open-external' })).toMatchObject({
      status: 'verified',
    });
    expect(ports.activate).toHaveBeenCalledOnce();
    const commands = actions.filter((action) => action.kind === 'command');
    expect(commands.filter((action) => action.method === 'Page.bringToFront')).toHaveLength(1);
    expect(commands.every((action) => action.tab === 19)).toBe(true);
    expect(embedded.page).not.toHaveBeenCalled();

    onViewport.mockImplementationOnce(() => {
      broker.endTurn('a');
    });
    expect(await preview.capture(signal)).toBeNull();
    expect(signal.aborted).toBe(true);

    expect(await app.disconnect(name.id)).toEqual({ status: 'verified', value: null });
    await vi.waitFor(async () => {
      expect(await browser.snapshot('a', tab)).toBeNull();
    });
    expect(actions).toContainEqual({ kind: 'forget' });
  } finally {
    await broker.close();
    await browser.close();
    app.close();
    extension.current?.socket.destroy();
    await rm(folder, { recursive: true, force: true });
  }
});

it('refuses a Chrome tab as needing setup when no connection came back while it waited', async () => {
  const engine = { page: vi.fn(), clear: vi.fn() } satisfies EmbeddedEngine;
  const chrome = { requirement: () => undefined, liveTab: () => Promise.resolve(null) };
  const { tools } = embeddedBrowser(engine, () => broker, chrome);
  const broker = new AutomationBroker(tools);
  await broker.bind('a', process.cwd(), { mode: 'auto', sandbox: 'workspace-write' });
  const access = broker.openAccess('a');
  broker.beginTurn('a');
  const { outcome } = await broker.dispatch(
    access,
    'browser_open',
    { sharing: 'global' },
    { actionId: 'lost' },
  );
  expect(outcome).toEqual({
    status: 'refused',
    code: 'setup-required',
    dispatched: false,
    detail: { kind: 'setup', requirement: { kind: 'browser', browser: 'chrome', step: 'connect' } },
  });
  expect(engine.page).not.toHaveBeenCalled();
});

it('waits for a saved connection only within its retry period, and not past a stop', async () => {
  const folder = await mkdtemp('/private/tmp/chrome-wait-');
  const proof = randomBytes(32).toString('hex');
  await writeFile(join(folder, 'connection.json'), JSON.stringify({ profile: name, proof }), {
    mode: 0o600,
  });
  const ports = {
    profiles: vi.fn(() => Promise.resolve({ status: 'read' as const, profiles: [name] })),
    build,
    install: vi.fn(() => Promise.resolve()),
    renew: vi.fn(() => Promise.resolve()),
    openSetup: vi.fn(() => Promise.resolve()),
    activate: vi.fn(() => Promise.resolve()),
    reconnectMs: 300,
  };
  const app = new ChromeProfileConnection(folder, ports);
  try {
    expect(app.requirement()).toBeUndefined();
    const stop = new AbortController();
    const stopped = app.liveTab(stop.signal);
    stop.abort();
    expect(await stopped).toBeNull();
    const started = Date.now();
    expect(await app.liveTab(new AbortController().signal)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    // Past its retry period nothing comes back by itself: Chrome needs the user, at once.
    expect(app.requirement()).toEqual({ kind: 'browser', browser: 'chrome', step: 'connect' });
    const now = Date.now();
    expect(await app.liveTab(new AbortController().signal)).toBeNull();
    expect(Date.now() - now).toBeLessThan(100);
  } finally {
    app.close();
    await rm(folder, { recursive: true, force: true });
  }
});
