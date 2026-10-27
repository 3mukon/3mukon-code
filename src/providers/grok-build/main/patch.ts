import { isAbsolute, relative } from 'node:path';
import type { Diff } from '@agentclientprotocol/sdk';
import { structuredPatch } from 'diff';
import type { FileChange } from '../../../sessions/shared/events';

// A path as the user reads it: relative to the session's folder when it lies inside, else absolute.
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? path : inside;
}

// One of ACP's diffs as a session file change. A diff holds a file's whole text before and after: a file
// without a text before, or with an empty one as Grok gives a file it creates, is new, and a deleted
// file's text after is left out.
export function fileChange(id: string, diff: Diff, deleted: boolean, cwd: string): FileChange {
  const path = displayPath(diff.path, cwd);
  const before = diff.oldText ?? '';
  if (before === '') {
    return {
      id,
      path,
      kind: 'add',
      diff: textDiff('/dev/null', label('b', path), '', diff.newText),
    };
  }
  if (deleted) {
    return { id, path, kind: 'delete', diff: textDiff(label('a', path), '/dev/null', before, '') };
  }
  return {
    id,
    path,
    kind: 'update',
    diff: textDiff(label('a', path), label('b', path), before, diff.newText),
  };
}

// A unified diff between two whole texts.
function textDiff(from: string, to: string, before: string, after: string): string {
  const lines = [`--- ${from}`, `+++ ${to}`];
  for (const hunk of structuredPatch('', '', before, after).hunks) {
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

function label(side: 'a' | 'b', path: string): string {
  return isAbsolute(path) ? path : `${side}/${path}`;
}
