import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallView } from '../shared/installs';
import { integrity, serve, tarball } from './builds-fake';
import { type InstallSpec, NotInstalledError } from './install';
import { createInstalls } from './installs';

let root: string;
let server: Server;
let url: string;
let requests: () => number;
const bodies = new Map<string, Buffer>();
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'installs-'));
  ({ server, url, requests } = await serve(bodies));
});
afterEach(async () => {
  bodies.clear();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

// A CLI of the test's own in a folder of its own, which prints the version.
function cli(name: string, output: string): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'tool'), `#!/bin/sh\necho '${output}'\n`);
  chmodSync(join(folder, 'tool'), 0o755);
  return folder;
}

function spec(build: Buffer, path = '/tool.tgz'): InstallSpec {
  return {
    provider: 'codex-cli',
    command: 'tool',
    oldest: '1.0.0',
    version: (output) => /tool (\S+)/.exec(output)?.[1] ?? null,
    pin: {
      version: '1.2.0',
      url: `${url}${path}`,
      integrity: integrity(build),
      folder: 'package',
      binary: 'tool',
    },
  };
}

function setUp(folders: string[], build: Buffer) {
  const installs = createInstalls({
    folder: join(root, 'data', 'providers'),
    searchFolders: () => folders,
    fetch: (address, init) => fetch(address, init),
  });
  return installs.for(spec(build));
}

describe('where a provider’s processes come from', () => {
  it('is the user’s CLI where it is the oldest version the adapter drives or newer', async () => {
    const build = tarball(root, { tool: '#!/bin/sh\necho tool 1.2.0\n' });
    const install = setUp(
      [join(root, 'missing'), cli('older-first', 'tool 1.0.0'), cli('newer', 'tool 9.0.0')],
      build,
    );
    expect(await install.current()).toEqual({
      path: join(root, 'older-first', 'tool'),
      version: '1.0.0',
      source: 'user',
    });
    expect(await install.prepare()).toMatchObject({ source: 'user' });
    expect(await install.view()).toEqual({
      runs: { source: 'user', version: '1.0.0' },
      pinned: '1.2.0',
    });
    expect(requests()).toBe(0);
  });

  it('passes over a CLI that is older, or whose version it cannot read, and says so', async () => {
    const build = tarball(root, { tool: '#!/bin/sh\necho tool 1.2.0\n' });
    const older = cli('older', 'tool 0.9.0');
    const install = setUp([older], build);
    await expect(install.current()).rejects.toBeInstanceOf(NotInstalledError);
    expect(await install.view()).toEqual({
      runs: null,
      passedOver: { path: join(older, 'tool'), version: '0.9.0', oldest: '1.0.0' },
      pinned: '1.2.0',
    });
    const silent = setUp([cli('silent', 'no version')], build);
    expect((await silent.view()).passedOver).toMatchObject({ version: null });
  });

  it('downloads the pinned copy for a sign-in or a session once, and runs it from then on', async () => {
    const build = tarball(root, { tool: '#!/bin/sh\necho tool 1.2.0\n' });
    bodies.set('/tool.tgz', build);
    const install = setUp([cli('older', 'tool 0.9.0')], build);
    const views: InstallView[] = [];
    install.onChange((view) => views.push(view));
    const [first, second] = await Promise.all([install.prepare(), install.prepare()]);
    expect(requests()).toBe(1);
    expect(first).toEqual(second);
    expect(first).toEqual({
      path: join(root, 'data', 'providers', 'codex-cli', '1.2.0', 'tool'),
      version: '1.2.0',
      source: 'app',
    });
    expect(await install.current()).toEqual(first);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(views.some((view) => view.downloading !== undefined)).toBe(true);
    expect(views.at(-1)).toMatchObject({ runs: { source: 'app', version: '1.2.0' } });
    expect(views.at(-1)?.downloading).toBeUndefined();
    expect(await install.prepare()).toEqual(first);
    expect(requests()).toBe(1);
  });

  it('keeps running an older copy the adapter drives where the download fails, saying why until one succeeds', async () => {
    const older = tarball(root, { tool: '#!/bin/sh\necho tool 1.1.0\n' });
    bodies.set('/older.tgz', older);
    const data = join(root, 'data', 'providers');
    const before = createInstalls({
      folder: data,
      searchFolders: () => [],
      fetch: (a, i) => fetch(a, i),
    }).for({
      ...spec(older, '/older.tgz'),
      pin: { ...spec(older, '/older.tgz').pin, version: '1.1.0' },
    });
    await before.prepare();
    const build = tarball(root, { tool: '#!/bin/sh\necho tool 1.2.0\n' });
    const install = setUp([], build);
    expect(await install.current()).toMatchObject({ version: '1.1.0', source: 'app' });
    expect(await install.prepare()).toMatchObject({ version: '1.1.0', source: 'app' });
    expect(await install.view()).toEqual({
      runs: { source: 'app', version: '1.1.0' },
      pinned: '1.2.0',
      failed: 'network',
    });
    bodies.set('/tool.tgz', build);
    expect(await install.prepare()).toMatchObject({ version: '1.2.0', source: 'app' });
    expect(await install.view()).toEqual({
      runs: { source: 'app', version: '1.2.0' },
      pinned: '1.2.0',
    });
  });

  it('rejects a sign-in with no copy to fall back on where the download fails', async () => {
    const build = tarball(root, { tool: '#!/bin/sh\necho tool 1.2.0\n' });
    bodies.set('/tool.tgz', Buffer.from('not the build'));
    const install = setUp([], build);
    await expect(install.prepare()).rejects.toMatchObject({ problem: 'checksum' });
    expect(await install.view()).toEqual({ runs: null, pinned: '1.2.0', failed: 'checksum' });
  });

  it('takes the tests’ pins in place of the adapter’s own', async () => {
    const build = tarball(root, { tool: '#!/bin/sh\necho tool 2.0.0\n' });
    bodies.set('/test.tgz', build);
    const installs = createInstalls({
      folder: join(root, 'data', 'providers'),
      searchFolders: () => [],
      fetch: (address, init) => fetch(address, init),
      pins: { 'codex-cli': { ...spec(build, '/test.tgz').pin, version: '2.0.0' } },
    });
    expect(await installs.for(spec(tarball(root, { tool: 'other' }))).prepare()).toMatchObject({
      version: '2.0.0',
    });
  });
});
