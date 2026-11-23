import { randomUUID } from 'node:crypto';
import { cp, lstat, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HELPER_NAME } from '../shared/helper';

const bundleName = HELPER_NAME + '.app';

// Where the helper runs from: the app's own folder, which holds the build the app carries. macOS
// counts a program inside an app's bundle as that app for some permissions, and the helper's are
// its own. `verify` checks a bundle's signature.
export async function installHelper(
  packaged: string,
  folder: string,
  verify: (bundle: string) => Promise<void>,
): Promise<string> {
  const installed = join(folder, bundleName);
  if (!(await same(packaged, installed))) {
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
  }
  await verify(installed);
  return installed;
}

// Whether two bundles hold the same files with the same bytes and permissions.
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
    const [bytes, otherBytes] = await Promise.all([
      readFile(join(one, name)),
      readFile(join(other, name)),
    ]);
    if (!bytes.equals(otherBytes)) return false;
  }
  return true;
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
