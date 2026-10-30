import { mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileWatcher } from './watch';

let root: string;
let reported: string[];
let watcher: FileWatcher;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'watch-')));
  reported = [];
  watcher = new FileWatcher((path) => reported.push(path), 20);
});
afterEach(() => {
  watcher.close();
  rmSync(root, { recursive: true, force: true });
});

// Lets the file system's events arrive and settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe('FileWatcher', () => {
  it('reports a change to a watched file, and none to other files in its folder', async () => {
    const watched = join(root, 'a.ts');
    writeFileSync(watched, '1');
    writeFileSync(join(root, 'b.ts'), '1');
    watcher.set([watched]);
    await settle();
    reported.length = 0;
    writeFileSync(join(root, 'b.ts'), '2');
    writeFileSync(watched, '2');
    await vi.waitFor(() => {
      expect(reported).toContain(watched);
    });
    await settle();
    expect(reported.every((path) => path === watched)).toBe(true);
  });

  it('follows a file replaced through a rename, and one removed', async () => {
    const watched = join(root, 'a.ts');
    writeFileSync(watched, '1');
    watcher.set([watched]);
    await settle();
    reported.length = 0;
    writeFileSync(join(root, '.a.ts.tmp'), '2');
    renameSync(join(root, '.a.ts.tmp'), watched);
    await vi.waitFor(() => {
      expect(reported).toContain(watched);
    });
    await settle();
    reported.length = 0;
    unlinkSync(watched);
    await vi.waitFor(() => {
      expect(reported).toContain(watched);
    });
  });

  it('reports nothing once a file is no longer watched', async () => {
    const watched = join(root, 'a.ts');
    writeFileSync(watched, '1');
    watcher.set([watched]);
    await settle();
    watcher.set([]);
    reported.length = 0;
    writeFileSync(watched, '2');
    await settle();
    expect(reported).toEqual([]);
  });

  it('watches the files of several folders, and a folder it cannot watch reports nothing', async () => {
    const first = join(root, 'a.ts');
    const second = join(realpathSync(mkdtempSync(join(tmpdir(), 'watch-other-'))), 'b.ts');
    writeFileSync(first, '1');
    writeFileSync(second, '1');
    try {
      watcher.set([first, second, join(root, 'missing', 'c.ts')]);
      await settle();
      reported.length = 0;
      writeFileSync(second, '2');
      writeFileSync(first, '2');
      await vi.waitFor(() => {
        expect(new Set(reported)).toEqual(new Set([first, second]));
      });
    } finally {
      rmSync(join(second, '..'), { recursive: true, force: true });
    }
  });
});
