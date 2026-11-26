import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrity, serve, tarball } from './builds-fake';
import { type DownloadError, downloadBuild, type Progress } from './download';
import type { Pin } from './install';

let root: string;
let server: Server;
let url: string;
const bodies = new Map<string, Buffer>();
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'installs-download-'));
  ({ server, url } = await serve(bodies));
});
afterEach(async () => {
  bodies.clear();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

function staging(): string {
  return mkdtempSync(join(root, 'staging-'));
}

describe('a download', () => {
  it('unpacks the pin’s folder once the build matches its checksum, its binary for the user alone', async () => {
    const build = tarball(root, {
      'vendor/bin/codex': '#!/bin/sh\necho codex-cli 0.171.0\n',
      'vendor/path/rg': '#!/bin/sh\n',
      'README.md': 'other files stay out',
    });
    bodies.set('/codex.tgz', build);
    const pin: Pin = {
      version: '0.171.0',
      url: `${url}/codex.tgz`,
      integrity: integrity(build),
      folder: 'package/vendor',
      binary: 'bin/codex',
    };
    const progress: Progress[] = [];
    const copy = await downloadBuild(pin, staging(), fetch, (seen) => progress.push(seen));
    expect(readFileSync(join(copy, 'bin', 'codex'), 'utf8')).toContain('codex-cli 0.171.0');
    expect(statSync(join(copy, 'bin', 'codex')).mode & 0o777).toBe(0o700);
    expect(statSync(join(copy, 'path', 'rg')).isFile()).toBe(true);
    expect(progress[0]).toEqual({ received: 0, total: build.length });
    expect(progress.at(-1)).toEqual({ received: build.length, total: build.length });
  });

  it('unpacks a binary that comes compressed with brotli, without its suffix', async () => {
    const build = tarball(root, {
      'bin/grok.br': brotliCompressSync(Buffer.from('#!/bin/sh\necho grok\n')),
    });
    bodies.set('/grok.tgz', build);
    const pin: Pin = {
      version: '1.0.92',
      url: `${url}/grok.tgz`,
      integrity: integrity(build),
      folder: 'package/bin',
      binary: 'grok.br',
      brotli: true,
    };
    const copy = await downloadBuild(pin, staging(), fetch, () => undefined);
    expect(readFileSync(join(copy, 'grok'), 'utf8')).toBe('#!/bin/sh\necho grok\n');
    expect(() => statSync(join(copy, 'grok.br'))).toThrow();
  });

  it('says what failed: the address, the checksum, or a build without the binary', async () => {
    const build = tarball(root, { claude: '#!/bin/sh\n' });
    bodies.set('/claude.tgz', build);
    const pin: Pin = {
      version: '2.1.330',
      url: `${url}/claude.tgz`,
      integrity: integrity(build),
      folder: 'package',
      binary: 'claude',
    };
    const problem = (attempt: Promise<unknown>) =>
      attempt.then(
        () => null,
        (error: unknown) => (error as DownloadError).problem,
      );
    expect(
      await problem(
        downloadBuild({ ...pin, url: `${url}/missing.tgz` }, staging(), fetch, () => undefined),
      ),
    ).toBe('network');
    expect(
      await problem(
        downloadBuild(
          { ...pin, integrity: integrity(Buffer.from('other')) },
          staging(),
          fetch,
          () => undefined,
        ),
      ),
    ).toBe('checksum');
    expect(
      await problem(downloadBuild({ ...pin, binary: 'other' }, staging(), fetch, () => undefined)),
    ).toBe('unpack');
    expect(
      await problem(
        downloadBuild({ ...pin, folder: 'package/none' }, staging(), fetch, () => undefined),
      ),
    ).toBe('unpack');
  });
});
