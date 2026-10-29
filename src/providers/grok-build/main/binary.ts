import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';

const decompress = promisify(brotliDecompress);

// How long a copy that no build of the app runs stays in the folder. Builds that share the app's data
// folder, such as a development build beside a packaged app, may each run another version, and each
// keeps its own copy in use.
const UNUSED_COPY_MS = 7 * 24 * 60 * 60 * 1000;

// The binary that a Grok Build package carries, compressed, and the version it is.
export interface GrokPackage {
  version: string;
  compressed: string;
}

// The pinned Grok Build package for macOS on Apple silicon, the one platform the app runs on
// (ADR-0004). The app depends on it directly rather than on @xai-official/grok, whose install script
// would copy the binary into the user's Grok home.
export function bundledGrokPackage(): GrokPackage {
  const manifest = createRequire(import.meta.url).resolve(
    '@xai-official/grok-darwin-arm64/package.json',
  );
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  return { version, compressed: join(dirname(manifest), 'bin', 'grok.br') };
}

// The package's binary, unpacked into the folder once per version and run from there. The folder is the
// app's own: one that is a link, or that anyone but the user can write to, is refused rather than run
// from. A binary appears under its name only once it is whole, and anything else under that name is
// replaced by a fresh copy. Each time, the copy is marked as run, and the copies no build has run for
// a week go.
export async function bundledGrokBinary(
  folder: string,
  bundled: GrokPackage = bundledGrokPackage(),
): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const found = await lstat(folder);
  if (
    found.isSymbolicLink() ||
    !found.isDirectory() ||
    found.uid !== process.getuid?.() ||
    (found.mode & 0o022) !== 0
  ) {
    throw new Error(`The folder for Grok Build's binary is not the app's own: ${folder}`);
  }
  const name = `grok-${bundled.version}`;
  const binary = join(folder, name);
  if (!(await isPrivateExecutable(binary))) {
    const contents = await decompress(await readFile(bundled.compressed));
    const partial = join(folder, `.grok-${bundled.version}-${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(partial, contents, { mode: 0o700, flag: 'wx' });
      await rename(partial, binary);
    } finally {
      await rm(partial, { force: true });
    }
  }
  const now = new Date();
  await utimes(binary, now, now).catch(() => undefined);
  await removeUnusedCopies(folder, name, now.getTime());
  return binary;
}

// Removes the copies in the folder that no build has run for a while: copies of other versions, which
// each build marks as it runs its own, and partial copies that an unpacking did not finish. A partial
// copy being written is new and stays, as does anything that is no copy or no file; a copy that cannot
// be removed waits for the next time.
async function removeUnusedCopies(folder: string, own: string, now: number): Promise<void> {
  const names = await readdir(folder).catch(() => []);
  await Promise.all(
    names
      .filter((name) => (name.startsWith('grok-') || name.startsWith('.grok-')) && name !== own)
      .map(async (name) => {
        const path = join(folder, name);
        const found = await lstat(path).catch(() => undefined);
        if (found?.isFile() !== true || now - found.mtimeMs < UNUSED_COPY_MS) return;
        await rm(path, { force: true }).catch(() => undefined);
      }),
  );
}

async function isPrivateExecutable(path: string): Promise<boolean> {
  try {
    const found = await lstat(path);
    return (
      found.isFile() &&
      found.size > 0 &&
      found.uid === process.getuid?.() &&
      (found.mode & 0o022) === 0 &&
      (found.mode & 0o100) !== 0
    );
  } catch {
    return false;
  }
}
