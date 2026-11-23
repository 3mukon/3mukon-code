import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeConnector, extensionBuild } from '../../src/browser/main/chrome-connector';
import { waitForLocalChromeExtension } from '../../src/browser/main/chrome-local-setup';
import { ChromeProfileConnection } from '../../src/browser/main/chrome-profile';

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp('/private/tmp/chrome-update-');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe('the saved connection', () => {
  const profile = { id: 'Profile 3', name: 'Synthetic Work' };
  const proof = 'a'.repeat(64);
  const ports = () => ({
    build: 'build2',
    profiles: vi.fn(() => Promise.resolve({ status: 'read' as const, profiles: [profile] })),
    install: vi.fn(() => Promise.resolve()),
    renew: vi.fn(() => Promise.resolve()),
    openSetup: vi.fn(() => Promise.resolve()),
    activate: vi.fn(() => Promise.resolve()),
  });
  const channel = () =>
    stat(join(folder, 'channel')).then(
      (found) => found.isSocket(),
      () => false,
    );
  // The extension of a build, as the native host brings it: what it hears first, or that it is
  // refused.
  async function restore(build: string): Promise<unknown> {
    const socket = createConnection(join(folder, 'channel'));
    const body = Buffer.from(JSON.stringify({ kind: 'restore', proof, build }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    socket.write(Buffer.concat([prefix, body]));
    const heard = once(socket, 'data').then(
      ([bytes]) => JSON.parse((bytes as Buffer).subarray(4).toString('utf8')) as unknown,
    );
    const refused = once(socket, 'close').then(() => 'refused');
    return Promise.race([heard.catch(() => 'refused'), refused]);
  }
  beforeEach(async () => {
    await writeFile(join(folder, 'connection.json'), JSON.stringify({ profile, proof }));
  });

  it('renews what Chrome uses before Chrome can connect', async () => {
    const renewing = Promise.withResolvers<undefined>();
    const given = { ...ports(), renew: vi.fn(() => renewing.promise) };
    const app = new ChromeProfileConnection(folder, given);
    try {
      expect(given.renew).toHaveBeenCalledOnce();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await channel()).toBe(false);
      renewing.resolve(undefined);
      await vi.waitFor(async () => {
        expect(await channel()).toBe(true);
      });
    } finally {
      app.close();
    }
  });

  it('refuses an extension of another build, which connects again once it runs this one', async () => {
    const app = new ChromeProfileConnection(folder, ports());
    try {
      await vi.waitFor(async () => {
        expect(await channel()).toBe(true);
      });
      expect(await restore('build1')).toBe('refused');
      expect(app.profile()).toBeNull();
      expect(app.rememberedProfile()).toEqual(profile);
      expect(await restore('build2')).toEqual({ kind: 'ready' });
      expect(app.profile()).toEqual(profile);
    } finally {
      app.close();
    }
  });

  it('still takes connections where the renewal fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new ChromeProfileConnection(folder, {
      ...ports(),
      renew: () => Promise.reject(new Error('A disk is full.')),
    });
    try {
      await vi.waitFor(async () => {
        expect(await channel()).toBe(true);
      });
      expect(error).toHaveBeenCalledOnce();
      expect(await restore('build2')).toEqual({ kind: 'ready' });
    } finally {
      app.close();
    }
  });
});

describe('the connector’s files', () => {
  const bundle = () => join(folder, 'bundle');
  const installed = () => join(folder, 'app', 'chrome-link');
  const registered = () =>
    join(folder, 'chrome', 'NativeMessagingHosts', 'io.github.sanmukon.browser.json');
  const connector = () =>
    chromeConnector({
      directory: installed(),
      browserData: join(folder, 'chrome'),
      hostExecutable: join(bundle(), 'BrowserHost'),
      bundledExtension: join(bundle(), 'extension'),
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    });
  // One build of the app's connector: its files are the same but the worker.
  async function build(name: string): Promise<void> {
    await mkdir(join(bundle(), 'extension', 'parts'), { recursive: true });
    await writeFile(join(bundle(), 'BrowserHost'), `host ${name}`, { mode: 0o755 });
    await writeFile(join(bundle(), 'extension', 'manifest.json'), '{}');
    await writeFile(join(bundle(), 'extension', 'parts', 'kept.js'), 'kept');
    await writeFile(join(bundle(), 'extension', 'worker.js'), `worker ${name}`);
    await writeFile(join(bundle(), 'extension', 'build.js'), `export const build = '${name}';\n`);
  }
  const read = (file: string) => readFile(join(installed(), file), 'utf8');
  const facts = (file: string) => stat(join(installed(), file), { bigint: true });
  beforeEach(async () => {
    await mkdir(installed(), { recursive: true });
    await build('build1');
  });

  it('installs the extension, the host and its registration at Connect', async () => {
    expect(connector().extension).toBe(join(installed(), 'extension'));
    await connector().install();
    expect(await extensionBuild(connector().extension)).toBe('build1');
    expect(await read('extension/parts/kept.js')).toBe('kept');
    expect(await read('BrowserHost')).toBe('host build1');
    expect((await stat(join(installed(), 'BrowserHost'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(registered(), 'utf8'))).toEqual({
      name: 'io.github.sanmukon.browser',
      description: 'The 3mukon-code Chrome browser connector',
      path: join(installed(), 'BrowserHost'),
      type: 'stdio',
      allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'],
    });
  });

  it('brings what is installed to another build, the build’s name last, and leaves what is the same', async () => {
    await connector().install();
    const kept = await facts('extension/parts/kept.js');
    const host = await facts('BrowserHost');
    await build('build2');
    await connector().renew();
    expect(await read('extension/worker.js')).toBe('worker build2');
    expect(await extensionBuild(connector().extension)).toBe('build2');
    expect(await read('BrowserHost')).toBe('host build2');
    // A program that runs the host keeps the file it opened.
    expect((await facts('BrowserHost')).ino).not.toBe(host.ino);
    expect((await facts('extension/parts/kept.js')).ino).toBe(kept.ino);
    expect((await facts('extension/build.js')).ctimeNs).toBeGreaterThanOrEqual(
      (await facts('extension/worker.js')).ctimeNs,
    );
    const worker = await facts('extension/worker.js');
    await connector().renew();
    expect((await facts('extension/worker.js')).ino).toBe(worker.ino);
  });

  it('installs nothing that Connect has not', async () => {
    await connector().renew();
    await expect(stat(join(installed(), 'extension'))).rejects.toThrow('ENOENT');
    await expect(stat(join(installed(), 'BrowserHost'))).rejects.toThrow('ENOENT');
    await expect(stat(registered())).rejects.toThrow('ENOENT');
  });

  it('renews its own registration and never another’s', async () => {
    await connector().install();
    const own = { path: join(installed(), 'BrowserHost'), description: 'An earlier build' };
    await writeFile(registered(), JSON.stringify(own));
    await connector().renew();
    expect(await readFile(registered(), 'utf8')).toContain('The 3mukon-code Chrome browser');
    const other = JSON.stringify({ path: '/elsewhere/BrowserHost' });
    await writeFile(registered(), other);
    await connector().renew();
    expect(await readFile(registered(), 'utf8')).toBe(other);
    await rm(join(installed(), 'extension'), { recursive: true });
    await expect(connector().install()).rejects.toThrow('different browser host');
    await expect(stat(join(installed(), 'extension'))).rejects.toThrow('ENOENT');
  });

  it('names a build by the extension’s files', async () => {
    const source = new URL('../../scripts/stamp-chrome-extension.mjs', import.meta.url);
    const { stampExtension } = (await import(source.href)) as {
      stampExtension: (folder: string) => Promise<string>;
    };
    const extension = join(bundle(), 'extension');
    const first = await stampExtension(extension);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(await extensionBuild(extension)).toBe(first);
    expect(await stampExtension(extension)).toBe(first);
    await writeFile(join(extension, 'worker.js'), 'worker changed');
    expect(await stampExtension(extension)).not.toBe(first);
  });
});

describe('the setup page', () => {
  // Runs the page's script against an extension that gives these answers in turn.
  async function setUp(answers: unknown[]): Promise<{ missing: number }> {
    const missing = vi.fn();
    await waitForLocalChromeExtension(
      { id: 'abcdefghijklmnopabcdefghijklmnop', build: 'build2' },
      async (url) => {
        const { origin, pathname } = new URL(url);
        const script = await (await fetch(url + '/probe.js')).text();
        runInNewContext(script, {
          location: { pathname },
          document: { querySelector: () => ({}) },
          window: { close: () => undefined },
          chrome: {
            runtime: {
              sendMessage: (_id: string, _message: object, reply: (answer: unknown) => void) => {
                reply(answers.length > 1 ? answers.shift() : answers[0]);
              },
            },
          },
          fetch: (path: string, init: object) =>
            fetch(origin + path, { ...init, headers: { origin } }),
          setTimeout: (next: () => void) => setTimeout(next, 2),
        });
      },
      missing,
      new AbortController().signal,
    );
    return { missing: missing.mock.calls.length };
  }

  it('says that the extension is missing only after several answers in a row', async () => {
    expect(await setUp([undefined, undefined, 'build2'])).toEqual({ missing: 0 });
    expect(await setUp([...Array<undefined>(12), 'build2'])).toEqual({ missing: 1 });
  });

  it('waits for an extension of this build', async () => {
    expect(await setUp(['build1', undefined, 'build2'])).toEqual({ missing: 0 });
    expect(await setUp([...Array<string>(12).fill('build1'), 'build2'])).toEqual({ missing: 1 });
  });
});

describe('the extension’s worker', () => {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const stored = new Map<string, string>();
  const reload = vi.fn();
  const ports: { sent: unknown[]; disconnect: () => void }[] = [];
  let folderHolds: string | null;
  const on = (name: string) => ({
    addListener: (listener: (...args: never[]) => unknown) => {
      listeners.set(name, listener);
    },
  });

  // Starts the worker, which runs the build its module names, with a saved connection.
  async function start(): Promise<void> {
    vi.resetModules();
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: (path: string) => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/' + path,
        reload,
        connectNative: () => {
          const ended: (() => void)[] = [];
          const port = {
            sent: [] as unknown[],
            postMessage: (message: unknown) => port.sent.push(message),
            disconnect: () => {
              for (const end of ended) end();
            },
            onMessage: { addListener: () => undefined },
            onDisconnect: { addListener: (end: () => void) => ended.push(end) },
          };
          ports.push(port);
          return port;
        },
        onMessageExternal: on('external'),
        onMessage: on('message'),
        onStartup: on('startup'),
      },
      storage: {
        local: {
          get: (key: string) => Promise.resolve(stored.has(key) ? { [key]: stored.get(key) } : {}),
          set: (values: Record<string, string>) => {
            for (const [key, value] of Object.entries(values)) stored.set(key, value);
            return Promise.resolve();
          },
          remove: (key: string) => Promise.resolve(stored.delete(key)),
        },
      },
      tabs: { onRemoved: on('removed'), onCreated: on('created') },
      permissions: { onRemoved: on('permissions') },
      debugger: { onEvent: on('event'), onDetach: on('detach') },
      declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
      alarms: {
        onAlarm: on('alarm'),
        get: () => Promise.resolve({}),
        create: () => Promise.resolve(),
      },
    });
    vi.stubGlobal('fetch', () =>
      folderHolds === null
        ? Promise.reject(new Error('The folder is gone.'))
        : Promise.resolve({
            text: () => Promise.resolve(`export const build = '${String(folderHolds)}';`),
          }),
    );
    const source = new URL('../../src/browser/native/chrome/extension/worker.js', import.meta.url);
    await import(source.href);
    await settle();
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const tell = async (name: string, ...args: unknown[]) => {
    const answer = (listeners.get(name) as ((...given: unknown[]) => unknown) | undefined)?.(
      ...args,
    );
    await settle();
    return answer;
  };
  const retry = () => tell('alarm', { name: 'connect-saved-browser' });
  const page = {
    frameId: 0,
    url: 'http://127.0.0.1:4000/chrome-setup/01234567-89ab-cdef-0123-456789abcdef',
  };
  beforeEach(() => {
    listeners.clear();
    stored.clear();
    stored.set('proof', 'b'.repeat(64));
    reload.mockClear();
    ports.length = 0;
    folderHolds = 'development';
  });

  it('connects with its build where its folder holds that build', async () => {
    await start();
    expect(reload).not.toHaveBeenCalled();
    expect(ports.map((port) => port.sent)).toEqual([
      [{ kind: 'restore', proof: 'b'.repeat(64), build: 'development' }],
    ]);
  });

  it('reloads once for another build in its folder, before it connects', async () => {
    folderHolds = 'newer1';
    await start();
    expect(reload).toHaveBeenCalledOnce();
    expect(ports).toEqual([]);
    expect(stored.get('reloadedFor')).toBe('newer1');
    // A reload that brought nothing new is not tried again, until Chrome starts again.
    await retry();
    expect(reload).toHaveBeenCalledOnce();
    expect(ports).toHaveLength(1);
    ports[0]?.disconnect();
    await tell('startup');
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('keeps its connection, and the tabs it has for tasks, while one is open', async () => {
    await start();
    folderHolds = 'newer1';
    await retry();
    const reply = vi.fn();
    await tell('external', { kind: 'connector-available' }, page, reply);
    expect(reply).toHaveBeenCalledExactlyOnceWith('development');
    expect(reload).not.toHaveBeenCalled();
    ports[0]?.disconnect();
    await retry();
    expect(reload).toHaveBeenCalledOnce();
    expect(ports).toHaveLength(1);
  });

  it('goes on where its folder cannot be read', async () => {
    folderHolds = null;
    await start();
    expect(reload).not.toHaveBeenCalled();
    expect(ports).toHaveLength(1);
  });

  it('answers the setup page with its build, or reloads first', async () => {
    stored.delete('proof');
    await start();
    const reply = vi.fn();
    expect(await tell('external', { kind: 'connector-available' }, page, reply)).toBe(true);
    expect(reply).toHaveBeenCalledExactlyOnceWith('development');
    const other = { ...page, url: 'http://127.0.0.1:4000/elsewhere' };
    expect(await tell('external', { kind: 'connector-available' }, other, reply)).toBe(false);
    expect(reply).toHaveBeenCalledOnce();
    folderHolds = 'newer1';
    await tell('external', { kind: 'connector-available' }, page, reply);
    expect(reply).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});
