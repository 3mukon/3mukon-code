import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { DroppedItem } from '../shared/panels';

// The folders and files at the paths of items dropped from the Finder, in their order. A link counts
// as what it points to; a relative path, a missing item and anything else are left out.
export async function droppedItems(paths: readonly string[]): Promise<DroppedItem[]> {
  const items = await Promise.all(paths.map((path) => itemAt(path)));
  return items.filter((item) => item !== null);
}

async function itemAt(path: string): Promise<DroppedItem | null> {
  if (!isAbsolute(path)) return null;
  try {
    const found = await stat(path);
    if (found.isDirectory()) return { kind: 'folder', path };
    if (found.isFile()) return { kind: 'file', path };
    return null;
  } catch {
    return null;
  }
}
