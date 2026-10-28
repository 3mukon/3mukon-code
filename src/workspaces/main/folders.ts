import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FolderEntry, FolderListing } from '../shared/workspaces';

// Git's own folder, which the trees leave out.
const GIT = '.git';

// The Finder's order: numbers by their value, and letters whatever their case and accents.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// The folder at path in the workspace folder root, as its tree shows it: folders first, then files,
// without .git. A link counts as what it points to, and a broken one as a file.
export async function listFolder(root: string, path: string): Promise<FolderListing> {
  const folder = join(root, ...segmentsOf(path));
  let items: Dirent[];
  try {
    items = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    return { error: isMissing(error) ? 'missing' : 'unreadable' };
  }
  const entries = await Promise.all(
    items
      .filter((item) => item.name !== GIT)
      .map(async (item): Promise<FolderEntry> => ({
        name: item.name,
        kind: await kindOf(folder, item),
      })),
  );
  return { entries: entries.sort(foldersFirst) };
}

// The names in a path relative to a workspace folder. A path that could leave the folder, or that
// names no folder plainly, is refused.
function segmentsOf(path: string): string[] {
  if (path === '') return [];
  const segments = path.split('/');
  const plain = (segment: string) =>
    segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\0');
  if (!segments.every(plain)) throw new Error('The path is not one inside the workspace.');
  return segments;
}

async function kindOf(folder: string, item: Dirent): Promise<FolderEntry['kind']> {
  if (item.isDirectory()) return 'folder';
  if (!item.isSymbolicLink()) return 'file';
  try {
    return (await stat(join(folder, item.name))).isDirectory() ? 'folder' : 'file';
  } catch {
    return 'file';
  }
}

function foldersFirst(left: FolderEntry, right: FolderEntry): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  // Names the collator takes as equal, such as a.txt and A.txt, keep one order every time.
  return collator.compare(left.name, right.name) || (left.name < right.name ? -1 : 1);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
