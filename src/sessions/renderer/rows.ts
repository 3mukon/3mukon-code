import { useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../shared/sessions';

// How many rows beyond those in view a list renders on either side, so that scrolling shows no gap
// before the next render.
const OVERSCAN = 8;
// How many rows a list takes to be in view until its scroll area is measured, as while it is out of
// sight.
const UNMEASURED_ROWS = 40;
// How long the pointer or the keyboard focus stays on a row, in milliseconds, before the session's
// history is read ahead, so that a pointer passing over the list reads nothing.
const READ_AHEAD_AFTER = 150;

// The indices of the rows, all of one height, that a list in a scroll area of its own renders: those
// in view and a few on either side, and the row with the keyboard focus wherever it lies, so that it
// keeps the focus. Measured again as the area scrolls or changes size, and as the rows' number
// changes, which can scroll it.
export function useVisibleRows(
  area: HTMLElement | null,
  count: number,
  rowHeight: number,
  focused: number,
): number[] {
  // The first row in view and how many rows the view holds; none until the area is measured.
  const [view, setView] = useState({ first: 0, rows: 0 });

  useLayoutEffect(() => {
    if (area === null) return;
    const measure = () => {
      const first = Math.floor(area.scrollTop / rowHeight);
      const rows = Math.ceil(area.clientHeight / rowHeight);
      setView((shown) => (shown.first === first && shown.rows === rows ? shown : { first, rows }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    area.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      area.removeEventListener('scroll', measure);
    };
  }, [area, count, rowHeight]);

  const start = Math.max(0, Math.min(view.first, count) - OVERSCAN);
  const end = Math.min(
    count,
    view.first + (view.rows === 0 ? UNMEASURED_ROWS : view.rows) + OVERSCAN,
  );
  return [
    ...(focused !== -1 && focused < start ? [focused] : []),
    ...Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset),
    ...(focused >= end ? [focused] : []),
  ];
}

// What reads a session's history ahead from its row, once, for a session that is not running: as a
// press on the row begins, or once the pointer or the keyboard focus has stayed on it, so that its
// page has the history as it opens.
export function useReadAhead(
  session: SessionSummary,
  onReadAhead: ((session: SessionSummary) => void) | undefined,
) {
  const readAhead = useRef<{ timer?: ReturnType<typeof setTimeout>; done: boolean }>({
    done: false,
  });
  const now = () => {
    clearTimeout(readAhead.current.timer);
    if (readAhead.current.done || session.status !== 'closed' || onReadAhead === undefined) return;
    readAhead.current.done = true;
    onReadAhead(session);
  };
  const soon = () => {
    clearTimeout(readAhead.current.timer);
    readAhead.current.timer = setTimeout(now, READ_AHEAD_AFTER);
  };
  const never = () => {
    clearTimeout(readAhead.current.timer);
  };
  return { now, soon, never };
}

// The last name in a path, or the path itself for the startup disk's root.
export function folderName(path: string): string {
  const name = path.replace(/\/+$/, '').split('/').at(-1);
  return name === undefined || name === '' ? path : name;
}
