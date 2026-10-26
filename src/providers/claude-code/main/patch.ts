import { isAbsolute, relative } from 'node:path';
import { structuredPatch } from 'diff';

// One hunk of a structured patch, as Claude Code's edit tools and the diff library both report it.
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// A path as the user reads it: relative to the session's folder when it lies inside, else absolute.
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? path : inside;
}

// A unified diff from structured hunks; a file that did not exist before is diffed from /dev/null.
export function unifiedDiff(path: string, hunks: readonly Hunk[], added: boolean): string {
  const lines = [added ? '--- /dev/null' : `--- ${label('a', path)}`, `+++ ${label('b', path)}`];
  for (const hunk of hunks) {
    lines.push(
      `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines,
    );
  }
  return `${lines.join('\n')}\n`;
}

// A hunk's range. An empty range starts at the line before it, as in diff and git: an added file's old
// range is 0,0.
function range(start: number, lines: number): string {
  return `${String(lines === 0 ? Math.max(0, start - 1) : start)},${String(lines)}`;
}

// A unified diff between two texts, such as an edit's old and new strings. Line numbers count from the
// start of the texts, not of the file they belong to.
export function diffTexts(path: string, before: string, after: string): string {
  return unifiedDiff(path, structuredPatch('', '', before, after).hunks, before === '');
}

function label(side: 'a' | 'b', path: string): string {
  return isAbsolute(path) ? path : `${side}/${path}`;
}
