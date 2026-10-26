import { describe, expect, it } from 'vitest';
import { displayPath, fileChange } from './patch';

const cwd = '/work/app';

describe('displayPath', () => {
  it('shows paths inside the folder relative to it, and others as they are', () => {
    expect(displayPath('/work/app/src/a.ts', cwd)).toBe('src/a.ts');
    expect(displayPath('/elsewhere/b.ts', cwd)).toBe('/elsewhere/b.ts');
    expect(displayPath('/work/app', cwd)).toBe('/work/app');
    expect(displayPath('src/c.ts', cwd)).toBe('src/c.ts');
  });
});

describe('fileChange', () => {
  it('diffs an added file from /dev/null, from the content Codex reports', () => {
    expect(
      fileChange(
        'c1',
        { path: '/work/app/notes.txt', kind: { type: 'add' }, diff: 'one\ntwo\n' },
        cwd,
      ),
    ).toEqual({
      id: 'c1',
      path: 'notes.txt',
      kind: 'add',
      diff: '--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    });
  });

  it('diffs a deleted file to /dev/null, from its former content', () => {
    expect(
      fileChange(
        'c2',
        { path: '/work/app/old.txt', kind: { type: 'delete' }, diff: 'gone\n' },
        cwd,
      ),
    ).toEqual({
      id: 'c2',
      path: 'old.txt',
      kind: 'delete',
      diff: '--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n',
    });
  });

  it('puts headers on the hunks of an updated file', () => {
    const change = {
      path: '/work/app/notes.txt',
      kind: { type: 'update' as const, move_path: null },
      diff: '@@ -1,2 +1,2 @@\n one\n-two\n+three',
    };
    expect(fileChange('c3', change, cwd)).toEqual({
      id: 'c3',
      path: 'notes.txt',
      kind: 'update',
      diff: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
    });
  });

  it('reports a move with the path the file went to', () => {
    const change = {
      path: '/work/app/a.txt',
      kind: { type: 'update' as const, move_path: '/work/app/b.txt' },
      diff: '@@ -1 +1 @@\n-x\n+y\n',
    };
    expect(fileChange('c4', change, cwd)).toEqual({
      id: 'c4',
      path: 'a.txt',
      kind: 'move',
      newPath: 'b.txt',
      diff: '--- a/a.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-x\n+y\n',
    });
  });
});
