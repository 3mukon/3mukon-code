import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const buildFile = 'build.js';

// Names a staged extension's build by its own files, so that each change of them is another build and
// the same files are always the same one. The app and the extension compare builds by that name.
export async function stampExtension(folder) {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .filter((file) => file !== buildFile)
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = await readFile(join(folder, file));
    hash.update(`${file}\0${String(bytes.length)}\0`).update(bytes);
  }
  const build = hash.digest('hex').slice(0, 16);
  await writeFile(join(folder, buildFile), `export const build = '${build}';\n`);
  return build;
}
