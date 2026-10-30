import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { DiffView, diffLines, linesChanged } from './diff-view';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const twoHunks = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+2',
  '',
  '@@ -10,2 +10,3 @@ function ten()',
  ' ten',
  '+eleven',
  ' twelve',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('diffLines', () => {
  it('numbers each hunk’s lines in the file before and after, with a gap between hunks', () => {
    expect(diffLines(twoHunks)).toEqual([
      { kind: 'kept', before: 1, after: 1, text: 'one' },
      { kind: 'removed', before: 2, text: 'two' },
      { kind: 'added', after: 2, text: '2' },
      // A blank line in a hunk, as some diffs give an empty kept line.
      { kind: 'kept', before: 3, after: 3, text: '' },
      { kind: 'gap' },
      { kind: 'kept', before: 10, after: 10, text: 'ten' },
      { kind: 'added', after: 11, text: 'eleven' },
      { kind: 'kept', before: 11, after: 12, text: 'twelve' },
    ]);
  });

  it('reads a new file’s lines from line 1', () => {
    expect(diffLines('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n')).toEqual([
      { kind: 'added', after: 1, text: 'a' },
      { kind: 'added', after: 2, text: 'b' },
    ]);
  });
});

describe('linesChanged', () => {
  it('counts added and removed lines, a removed line that starts with dashes among them', () => {
    expect(linesChanged('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n--- note\n+b\n+c\n')).toEqual({
      added: 2,
      removed: 2,
    });
  });
});

describe('DiffView', () => {
  it('shows each line after its numbers, the added and removed ones tinted, and no path', () => {
    const { container } = render(<DiffView diff={twoHunks} />);
    expect(container.textContent).not.toContain('src/a.ts');
    const added = screen.getByText('eleven');
    expect(added.className).toContain('bg-add/10');
    expect(added.previousElementSibling?.textContent).toBe('+');
    expect(added.previousElementSibling?.previousElementSibling?.textContent).toBe('11');
    expect(screen.getByText('two').className).toContain('bg-del/10');
    expect(screen.getByText('⋯')).toBeDefined();
  });

  it('shows at most 1,000 lines, and says how many it leaves out', () => {
    const lines = Array.from({ length: 1_005 }, (_, index) => `+line ${String(index + 1)}`);
    render(<DiffView diff={['@@ -0,0 +1,1005 @@', ...lines, ''].join('\n')} />);
    expect(screen.getByText('line 1000')).toBeDefined();
    expect(screen.queryByText('line 1001')).toBeNull();
    expect(screen.getByText('Lines not shown: 5')).toBeDefined();
  });
});
