import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';

const decompress = promisify(brotliDecompress);

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
// replaced by a fresh copy.
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
  const binary = join(folder, `grok-${bundled.version}`);
  if (await isPrivateExecutable(binary)) return binary;
  const contents = await decompress(await readFile(bundled.compressed));
  const partial = join(folder, `.grok-${bundled.version}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(partial, contents, { mode: 0o700, flag: 'wx' });
    await rename(partial, binary);
  } finally {
    await rm(partial, { force: true });
  }
  return binary;
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
