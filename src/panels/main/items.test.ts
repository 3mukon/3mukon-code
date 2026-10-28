import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { droppedItems } from './items';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'panels-items-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('droppedItems', () => {
  it('tells folders from files, in the order they were dropped', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), '');
    expect(await droppedItems([join(root, 'README.md'), join(root, 'src')])).toEqual([
      { kind: 'file', path: join(root, 'README.md') },
      { kind: 'folder', path: join(root, 'src') },
    ]);
  });

  it('counts a link as what it points to', async () => {
    mkdirSync(join(root, 'src'));
    symlinkSync(join(root, 'src'), join(root, 'link'));
    expect(await droppedItems([join(root, 'link')])).toEqual([
      { kind: 'folder', path: join(root, 'link') },
    ]);
  });

  it('leaves out relative paths, missing items and items that are neither', async () => {
    symlinkSync(join(root, 'nowhere'), join(root, 'broken'));
    expect(
      await droppedItems(['README.md', '', join(root, 'missing'), join(root, 'broken')]),
    ).toEqual([]);
  });
});
