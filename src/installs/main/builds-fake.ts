import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';

// Builds and a download server of the tests' own, for the installs module's tests and the smoke tests
// that download a provider's copy (ADR-0039).

// A build as the npm registry serves one: a gzipped tarball of a `package` folder.
export function tarball(folder: string, files: Record<string, string | Buffer>): Buffer {
  const source = mkdtempSync(join(folder, 'source-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(source, 'package', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
  }
  const archive = join(folder, `${basename(source)}.tgz`);
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', source, 'package']);
  return readFileSync(archive);
}

export function integrity(contents: Buffer): string {
  return `sha512-${createHash('sha512').update(contents).digest('base64')}`;
}

// A server of the test's own that answers each path with its body, or with 404, and counts the
// requests it takes.
export async function serve(
  bodies: Map<string, Buffer>,
): Promise<{ server: Server; url: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const body = bodies.get(request.url ?? '');
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}`, requests: () => requests };
}
