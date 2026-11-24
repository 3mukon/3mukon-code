import { randomUUID } from 'node:crypto';
import { cp, lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HELPER_NAME } from '../shared/helper';

const bundleName = HELPER_NAME + '.app';
const MACH_O_64 = 0xfeedfacf;
const CODE_SIGNATURE = 0x1d;

// Where the helper runs from: the app's own folder, which holds the build the app carries. macOS
// counts a program inside an app's bundle as that app for some permissions, and the helper's are
// its own. `verify` checks a bundle's signature. A copy of this build stays where it passes that
// check; one that fails it, as a copy changed after its install would, is replaced like a copy of
// another build.
export async function installHelper(
  packaged: string,
  folder: string,
  verify: (bundle: string) => Promise<void>,
): Promise<string> {
  const installed = join(folder, bundleName);
  if (await same(packaged, installed)) {
    try {
      await verify(installed);
      return installed;
    } catch {
      // Replaced below, from the packaged bundle, once that passes the check.
    }
  }
  await verify(packaged);
  // What an install that was cut short left.
  for (const name of await readdir(folder))
    if (name.startsWith(HELPER_NAME) && name !== bundleName)
      await rm(join(folder, name), { recursive: true, force: true });
  const stage = join(folder, HELPER_NAME + '.' + randomUUID());
  const old = join(folder, HELPER_NAME + '.' + randomUUID());
  try {
    await cp(packaged, stage, { recursive: true, verbatimSymlinks: true });
    // A helper that still runs keeps the bundle it started from.
    if (await exists(installed)) await rename(installed, old);
    await rename(stage, installed);
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
  await verify(installed);
  return installed;
}

// Whether two bundles hold the same files with the same sizes and permissions, the same code
// signature in each signed executable and the same bytes in every other file. A signature holds the
// hashes of its executable's code and of the bundle's sealed resources, and the check that follows
// proves that the files match it, so a signed executable is read no further than its signature: the
// helper's executable is 26 MB, its signature a few hundred KB.
async function same(one: string, other: string): Promise<boolean> {
  const [files, others] = await Promise.all([contents(one), contents(other)]);
  if (files.length !== others.length) return false;
  for (const [index, file] of files.entries()) {
    const counterpart = others[index];
    if (
      file.name !== counterpart?.name ||
      file.mode !== counterpart.mode ||
      file.size !== counterpart.size
    )
      return false;
  }
  for (const { name } of files) {
    const [signature, otherSignature] = await Promise.all([
      codeSignature(join(one, name)),
      codeSignature(join(other, name)),
    ]);
    if (signature !== undefined || otherSignature !== undefined) {
      if (signature === undefined || otherSignature === undefined) return false;
      if (!signature.equals(otherSignature)) return false;
      continue;
    }
    const [bytes, otherBytes] = await Promise.all([
      readFile(join(one, name)),
      readFile(join(other, name)),
    ]);
    if (!bytes.equals(otherBytes)) return false;
  }
  return true;
}

// The code signature a thin 64-bit Mach-O file carries, where its LC_CODE_SIGNATURE command points;
// undefined for any other file, an unsigned one included.
async function codeSignature(path: string): Promise<Buffer | undefined> {
  const file = await open(path, 'r');
  try {
    const read = async (length: number, position: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      return bytesRead === length ? buffer : undefined;
    };
    const header = await read(32, 0);
    if (header?.readUInt32LE(0) !== MACH_O_64) return undefined;
    const count = header.readUInt32LE(16);
    const size = header.readUInt32LE(20);
    if (size > 1024 * 1024) return undefined;
    const commands = await read(size, 32);
    if (commands === undefined) return undefined;
    for (let index = 0, offset = 0; index < count && offset + 16 <= size; index++) {
      const command = commands.readUInt32LE(offset);
      const length = commands.readUInt32LE(offset + 4);
      if (command === CODE_SIGNATURE) {
        const at = commands.readUInt32LE(offset + 8);
        const bytes = commands.readUInt32LE(offset + 12);
        if (bytes === 0 || bytes > 64 * 1024 * 1024) return undefined;
        return await read(bytes, at);
      }
      if (length < 8) return undefined;
      offset += length;
    }
    return undefined;
  } finally {
    await file.close();
  }
}

// Every file of a bundle, or none where there is no bundle. A link is no file.
async function contents(bundle: string) {
  if (!(await exists(bundle))?.isDirectory()) return [];
  const found: { name: string; mode: number; size: number }[] = [];
  for (const name of (await readdir(bundle, { recursive: true })).sort()) {
    const file = await lstat(join(bundle, name));
    if (!file.isDirectory())
      found.push({ name, mode: file.mode, size: file.isFile() ? file.size : -1 });
  }
  return found;
}

async function exists(path: string) {
  return lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    return undefined;
  });
}
