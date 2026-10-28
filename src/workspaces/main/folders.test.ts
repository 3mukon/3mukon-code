import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFolder } from './folders';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'folders-')));
});
afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('listFolder', () => {
  it('lists folders first, then files, in the Finder’s order, without .git', async () => {
    for (const folder of ['.git', 'src', 'Docs', 'v10', 'v2']) mkdirSync(join(root, folder));
    for (const file of ['B.txt', 'a.txt', 'file10', 'file2', '.gitignore']) {
      writeFileSync(join(root, file), '');
    }
    const listing = await listFolder(root, '');
    expect(listing).toEqual({
      entries: [
        { name: 'Docs', kind: 'folder' },
        { name: 'src', kind: 'folder' },
        { name: 'v2', kind: 'folder' },
        { name: 'v10', kind: 'folder' },
        { name: '.gitignore', kind: 'file' },
        { name: 'a.txt', kind: 'file' },
        { name: 'B.txt', kind: 'file' },
        { name: 'file2', kind: 'file' },
        { name: 'file10', kind: 'file' },
      ],
    });
  });

  it('lists a folder inside the workspace by its relative path', async () => {
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    writeFileSync(join(root, 'src', 'app', 'main.ts'), '');
    expect(await listFolder(root, 'src/app')).toEqual({
      entries: [{ name: 'main.ts', kind: 'file' }],
    });
  });

  it('counts a link as what it points to, and a broken one as a file', async () => {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'linked'));
    symlinkSync(join(root, 'nowhere'), join(root, 'broken'));
    expect(await listFolder(root, '')).toEqual({
      entries: [
        { name: 'linked', kind: 'folder' },
        { name: 'real', kind: 'folder' },
        { name: 'broken', kind: 'file' },
      ],
    });
  });

  it('says when a folder is gone or cannot be read', async () => {
    expect(await listFolder(root, 'gone')).toEqual({ error: 'missing' });
    writeFileSync(join(root, 'file'), '');
    expect(await listFolder(root, 'file')).toEqual({ error: 'missing' });
    chmodSync(root, 0o000);
    expect(await listFolder(root, '')).toEqual({ error: 'unreadable' });
  });

  it.each(['..', 'src/../..', '/etc', 'src//app', '.', 'src/'])(
    'refuses %j, which could leave the folder or names none plainly',
    async (path) => {
      await expect(listFolder(root, path)).rejects.toThrow('not one inside the workspace');
    },
  );
});
