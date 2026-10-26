import { describe, expect, it } from 'vitest';
import { diffTexts, displayPath, unifiedDiff } from './patch';

describe('displayPath', () => {
  it('shortens paths inside the session folder and keeps the others whole', () => {
    expect(displayPath('/work/app/src/a.ts', '/work/app')).toBe('src/a.ts');
    expect(displayPath('/work/other/b.ts', '/work/app')).toBe('/work/other/b.ts');
    expect(displayPath('src/c.ts', '/work/app')).toBe('src/c.ts');
    expect(displayPath('/work/app', '/work/app')).toBe('/work/app');
  });
});

describe('unifiedDiff', () => {
  it('writes hunks under a/ and b/ headers', () => {
    const diff = unifiedDiff(
      'src/a.ts',
      [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' keep', '-old', '+new'] }],
      false,
    );
    expect(diff).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\n');
  });

  it('diffs a new file from /dev/null', () => {
    expect(unifiedDiff('n.txt', [], true).startsWith('--- /dev/null\n+++ b/n.txt\n')).toBe(true);
  });
});

describe('diffTexts', () => {
  it('turns two texts into a unified diff of their lines', () => {
    const diff = diffTexts('src/a.ts', 'one\ntwo\n', 'one\nthree\n');
    expect(diff).toContain('--- a/src/a.ts');
    expect(diff).toContain('-two');
    expect(diff).toContain('+three');
  });

  it('starts an empty range at the line before it, as diff and git do', () => {
    expect(diffTexts('n.txt', '', 'hi\n')).toBe(
      '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+hi\n',
    );
    expect(diffTexts('o.txt', 'bye\n', '')).toBe(
      '--- a/o.txt\n+++ b/o.txt\n@@ -1,1 +0,0 @@\n-bye\n',
    );
  });
});
