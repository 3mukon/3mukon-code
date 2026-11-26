import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';
import type { DownloadProblem } from '../shared/installs';
import { isPrivateExecutable } from './copies';
import type { Pin } from './install';

const decompress = promisify(brotliDecompress);
const run = promisify(execFile);

// How long a download may go without a byte before it fails.
const STALL_MS = 60_000;

// How the app fetches a build: Electron's `net.fetch` in the app, which follows the system's proxy
// settings, and Node's own in tests.
export type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

// How far a download has come: the bytes received, and how many there are where the server says.
export interface Progress {
  received: number;
  total: number | null;
}

export class DownloadError extends Error {
  constructor(
    readonly problem: DownloadProblem,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DownloadError';
  }
}

// Downloads the pinned build into the staging folder, hashing it as it arrives, and only where it
// matches the pin's checksum unpacks the pin's folder from it with macOS's own tar, and the binary from
// brotli where the pin says so. Resolves with the unpacked folder, whose binary only the user may change
// and run; rejects with a DownloadError that says what failed.
export async function downloadBuild(
  pin: Pin,
  staging: string,
  fetch: Fetch,
  onProgress: (progress: Progress) => void,
): Promise<string> {
  const archive = join(staging, 'build.tgz');
  await fetchChecked(pin, archive, fetch, onProgress);
  const unpacked = join(staging, 'unpacked');
  await mkdir(unpacked, { mode: 0o700 });
  try {
    await run('/usr/bin/tar', ['-xzf', archive, '-C', unpacked, '--', pin.folder]);
  } catch (error) {
    throw new DownloadError('unpack', `The build of ${pin.version} could not be unpacked.`, {
      cause: error,
    });
  }
  await rm(archive, { force: true });
  const copy = join(unpacked, pin.folder);
  let binary = join(copy, pin.binary);
  try {
    if (pin.brotli === true) {
      const packed = binary;
      binary = packed.replace(/\.br$/, '');
      await writeFile(binary, await decompress(await readFile(packed)), {
        mode: 0o700,
        flag: 'wx',
      });
      await rm(packed);
    }
    await chmod(binary, 0o700);
  } catch (error) {
    throw new DownloadError('unpack', `The build of ${pin.version} holds no ${pin.binary}.`, {
      cause: error,
    });
  }
  if (!(await isPrivateExecutable(binary))) {
    throw new DownloadError('unpack', `The build of ${pin.version} holds no binary to run.`);
  }
  return copy;
}

// Fetches the pin's tarball into the file, failing where no byte comes for a minute, and checks it
// against the pin's checksum.
async function fetchChecked(
  pin: Pin,
  archive: string,
  fetch: Fetch,
  onProgress: (progress: Progress) => void,
): Promise<void> {
  const stalled = new AbortController();
  const stall = () => {
    stalled.abort();
  };
  let timer = setTimeout(stall, STALL_MS);
  const hash = createHash('sha512');
  const out = createWriteStream(archive, { flags: 'wx', mode: 0o600 });
  try {
    const response = await fetch(pin.url, { signal: stalled.signal });
    if (!response.ok || response.body === null) {
      throw new Error(`${pin.url} answered ${String(response.status)}.`);
    }
    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    let received = 0;
    onProgress({ received, total });
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(timer);
      timer = setTimeout(stall, STALL_MS);
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) {
        await new Promise<void>((resolve) => {
          out.once('drain', () => {
            resolve();
          });
        });
      }
      onProgress({ received, total });
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    out.destroy();
    throw new DownloadError('network', `The build of ${pin.version} could not be downloaded.`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
  if (`sha512-${hash.digest('base64')}` !== pin.integrity) {
    throw new DownloadError('checksum', `The build of ${pin.version} does not match its checksum.`);
  }
}
