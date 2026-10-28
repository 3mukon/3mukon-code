import { describe, expect, it } from 'vitest';
import { itemDragType, readItemDrag, writeItemDrag } from './item-drag';

// The part of a drag's data transfer the helpers use, as a page would hold it.
function transfer(data: Record<string, string> = {}): DataTransfer {
  return {
    effectAllowed: 'none',
    setData(type: string, value: string) {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

describe('item drags', () => {
  it('carry a folder or file from a tree to the panel area', () => {
    const drag = transfer();
    writeItemDrag(drag, { kind: 'folder', path: '/Users/me/web' });
    expect(drag.effectAllowed).toBe('copy');
    expect(readItemDrag(drag)).toEqual({ kind: 'folder', path: '/Users/me/web' });
  });

  it('carry nothing else', () => {
    expect(readItemDrag(transfer())).toBeNull();
    expect(readItemDrag(transfer({ [itemDragType]: 'not json' }))).toBeNull();
    expect(readItemDrag(transfer({ [itemDragType]: '{"kind":"app","path":"/x"}' }))).toBeNull();
    expect(readItemDrag(transfer({ [itemDragType]: '{"kind":"file","path":"x"}' }))).toBeNull();
    expect(readItemDrag(transfer({ [itemDragType]: '"text"' }))).toBeNull();
  });
});
