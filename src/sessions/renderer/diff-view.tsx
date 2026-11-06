import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

// One line of a diff as the view shows it: a line kept, added or removed, with its numbers in the file
// before and after the change, or the gap between two hunks.
export type DiffLine =
  | { kind: 'kept'; before: number; after: number; text: string }
  | { kind: 'added'; after: number; text: string }
  | { kind: 'removed'; before: number; text: string }
  | { kind: 'gap' };

// A view shows this many lines of a diff at most, so that a large new file stays cheap to open.
const SHOWN_LINES = 1_000;

// The lines of a unified diff's hunks, each hunk read for as many lines as its header counts; the file
// headers, and markers such as "\ No newline at end of file", are left out.
export function diffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let before = 0;
  let after = 0;
  let beforeLeft = 0;
  let afterLeft = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk !== null) {
      if (lines.length > 0) lines.push({ kind: 'gap' });
      before = Number(hunk[1]);
      beforeLeft = Number(hunk[2] ?? '1');
      after = Number(hunk[3]);
      afterLeft = Number(hunk[4] ?? '1');
      continue;
    }
    if (beforeLeft <= 0 && afterLeft <= 0) continue;
    const text = line.slice(1);
    if (line.startsWith('+')) {
      lines.push({ kind: 'added', after, text });
      after += 1;
      afterLeft -= 1;
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'removed', before, text });
      before += 1;
      beforeLeft -= 1;
    } else if (line.startsWith(' ') || line === '') {
      lines.push({ kind: 'kept', before, after, text });
      before += 1;
      after += 1;
      beforeLeft -= 1;
      afterLeft -= 1;
    }
  }
  return lines;
}

// How many lines a unified diff adds and removes.
export function linesChanged(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(diff)) {
    if (line.kind === 'added') added += 1;
    else if (line.kind === 'removed') removed += 1;
  }
  return { added, removed };
}

const looks = {
  kept: { row: '', marker: '', markerColour: '', text: '' },
  added: { row: 'bg-add/10', marker: '+', markerColour: 'text-add', text: 'text-ink' },
  removed: { row: 'bg-del/10', marker: '−', markerColour: 'text-del', text: 'text-ink' },
};

// A file's diff as its lines, each after its numbers in the file before and after the change, the
// added lines on a green tint and the removed ones on a red one, with a quiet gap between hunks. Long
// lines wrap, and a long diff scrolls within the view. The file's path is for whatever shows the view
// to give, once.
export function DiffView({ diff }: { diff: string }) {
  const { t, i18n } = useTranslation();
  const lines = useMemo(() => diffLines(diff), [diff]);
  const shown = lines.slice(0, SHOWN_LINES);
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-dashed border-line paper-well py-1 text-[11.5px]/[1.6] [tab-size:4]">
      <div className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)]">
        {shown.map((line, index) =>
          line.kind === 'gap' ? (
            <span key={index} className="col-span-full px-2.5 text-faint select-none">
              ⋯
            </span>
          ) : (
            <Line key={index} line={line} />
          ),
        )}
      </div>
      {lines.length > shown.length && (
        <p className="px-2.5 pt-1 text-faint">
          {t('sessions.diff.notShown', {
            lines: new Intl.NumberFormat(i18n.language).format(lines.length - shown.length),
          })}
        </p>
      )}
    </div>
  );
}

// A line's cells, each tinted, so that the tint runs the width of the view.
function Line({ line }: { line: Exclude<DiffLine, { kind: 'gap' }> }) {
  const look = looks[line.kind];
  return (
    <>
      <span className={`pr-1 pl-2.5 text-right text-faint tabular-nums select-none ${look.row}`}>
        {line.kind === 'added' ? '' : line.before}
      </span>
      <span className={`pr-2 text-right text-faint tabular-nums select-none ${look.row}`}>
        {line.kind === 'removed' ? '' : line.after}
      </span>
      <span className={`w-[1ch] select-none ${look.markerColour} ${look.row}`}>{look.marker}</span>
      <span className={`pr-2.5 pl-1.5 whitespace-pre-wrap wrap-anywhere ${look.text} ${look.row}`}>
        {line.text === '' ? ' ' : line.text}
      </span>
    </>
  );
}
