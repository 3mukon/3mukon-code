import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileService } from './files';

let root: string;
let workspace: string;
let elsewhere: string;
let folders: string[];
let files: FileService;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'files-')));
  workspace = join(root, 'web');
  elsewhere = join(root, 'elsewhere');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(elsewhere);
  writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
  writeFileSync(join(elsewhere, 'b.ts'), 'b');
  folders = [workspace];
  files = new FileService(() => folders, 20);
});
afterEach(() => {
  files.close();
  rmSync(root, { recursive: true, force: true });
});

const outside = { kind: 'notice', notice: 'outside' };

describe('FileService', () => {
  it('opens and saves files inside a workspace, and no others', async () => {
    expect(await files.open(join(workspace, 'src', 'a.ts'))).toEqual({
      kind: 'text',
      text: 'a',
      bom: false,
    });
    expect(await files.save(join(workspace, 'src', 'a.ts'), 'a2')).toEqual({ saved: true });
    expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toBe('a2');
    expect(await files.open(join(elsewhere, 'b.ts'))).toEqual(outside);
    expect(await files.save(join(elsewhere, 'b.ts'), 'b2')).toEqual({
      saved: false,
      reason: 'outside',
    });
    expect(readFileSync(join(elsewhere, 'b.ts'), 'utf8')).toBe('b');
  });

  it('refuses paths that are relative, or that could lead out of the workspace', async () => {
    for (const path of [
      'web/src/a.ts',
      `${workspace}/../elsewhere/b.ts`,
      `${workspace}/./src/a.ts`,
      `${workspace}//src/a.ts`,
      `${workspace}-other/a.ts`,
      `${workspace}/src/`,
    ]) {
      expect(await files.open(path)).toEqual(outside);
    }
  });

  it('opens files dropped on the window, and keeps a file it opened open once its workspace goes', async () => {
    files.grant([join(elsewhere, 'b.ts'), 'relative.ts']);
    expect((await files.open(join(elsewhere, 'b.ts'))).kind).toBe('text');
    expect((await files.open(join(workspace, 'src', 'a.ts'))).kind).toBe('text');
    folders = [];
    expect(await files.save(join(workspace, 'src', 'a.ts'), 'a3')).toEqual({ saved: true });
    writeFileSync(join(workspace, 'other.ts'), 'o');
    expect(await files.open(join(workspace, 'other.ts'))).toEqual(outside);
  });

  it('watches the files a window lists, until it lists others or goes', async () => {
    const watched = join(workspace, 'src', 'a.ts');
    const changed = vi.fn<(path: string) => void>();
    files.onChange(changed);
    files.watch(1, [watched, join(elsewhere, 'b.ts')]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(join(elsewhere, 'b.ts'), 'b2');
    writeFileSync(watched, 'a2');
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledWith(watched);
    });
    expect(changed).not.toHaveBeenCalledWith(join(elsewhere, 'b.ts'));

    files.watch(1, []);
    changed.mockClear();
    writeFileSync(watched, 'a3');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changed).not.toHaveBeenCalled();

    files.watch(2, [watched]);
    files.forget(2);
    writeFileSync(watched, 'a4');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changed).not.toHaveBeenCalled();
  });
});
