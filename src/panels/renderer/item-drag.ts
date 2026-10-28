import type { DroppedItem } from '../shared/panels';

// The type under which a folder or file dragged from one of the app's trees travels, as JSON.
export const itemDragType = 'application/x-3mukon-code-item';

// Puts a folder or file from one of the app's trees on a drag, for the panel area to open.
export function writeItemDrag(dataTransfer: DataTransfer, item: DroppedItem): void {
  dataTransfer.setData(itemDragType, JSON.stringify({ kind: item.kind, path: item.path }));
  dataTransfer.effectAllowed = 'copy';
}

// The folder or file a drag from one of the app's trees carries, or null for anything else.
export function readItemDrag(dataTransfer: DataTransfer): DroppedItem | null {
  let value: unknown;
  try {
    value = JSON.parse(dataTransfer.getData(itemDragType));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('path' in value)) {
    return null;
  }
  const { kind, path } = value;
  if ((kind !== 'folder' && kind !== 'file') || typeof path !== 'string' || !path.startsWith('/')) {
    return null;
  }
  return { kind, path };
}
