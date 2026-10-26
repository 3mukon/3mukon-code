import { isAbsolute, relative } from 'node:path';
import { structuredPatch } from 'diff';
import type { FileChange } from '../../../sessions/shared/events';
import type { FileUpdateChange } from './protocol/v2/FileUpdateChange';

// A path as the user reads it: relative to the session's folder when it lies inside, else absolute.
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? path : inside;
}

// One of Codex's file changes as a session file change. Codex reports an added file's content, a
// deleted file's former content and an updated file's hunks without headers; each becomes a unified
// diff with headers.
export function fileChange(id: string, change: FileUpdateChange, cwd: string): FileChange {
  const path = displayPath(change.path, cwd);
  switch (change.kind.type) {
    case 'add':
      return {
        id,
        path,
        kind: 'add',
        diff: textDiff('/dev/null', label('b', path), '', change.diff),
      };
    case 'delete':
      return {
        id,
        path,
        kind: 'delete',
        diff: textDiff(label('a', path), '/dev/null', change.diff, ''),
      };
    case 'update': {
      const movedTo = change.kind.move_path;
      const newPath = movedTo === null ? undefined : displayPath(movedTo, cwd);
      const hunks = change.diff.endsWith('\n') ? change.diff : `${change.diff}\n`;
      const diff = `--- ${label('a', path)}\n+++ ${label('b', newPath ?? path)}\n${hunks}`;
      return newPath === undefined
        ? { id, path, kind: 'update', diff }
        : { id, path, kind: 'move', newPath, diff };
    }
  }
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
