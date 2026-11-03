import { useId, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from '../../ui/renderer/icons';
import { Select } from '../../ui/renderer/select';
import { StatusDot } from '../../ui/renderer/status-dot';
import type { SessionSummary } from '../shared/sessions';
import { statusDots } from './timeline';

// The height of a session's row, in pixels, by which the lists lay out their rows.
export const ROW_HEIGHT = 28;
// How many rows beyond those in view the lists render on either side, so that scrolling shows no gap
// before the next render.
const OVERSCAN = 8;
// How many rows a list takes to be in view until its scroll area is measured, as while it is out of
// sight.
const UNMEASURED_ROWS = 40;

// A folder the list can be narrowed to, such as a workspace.
export interface SessionFolder {
  id: string;
  name: string;
  path: string;
}

interface SessionsSectionProps {
  // The sessions that are not archived, the most recently active first.
  sessions: SessionSummary[];
  // The folders the filter offers, in order.
  folders: SessionFolder[];
  // Opens a new session page; New session stays disabled without it.
  onNewSession?: () => void;
  // Shows a session, as a click on it in the list asks.
  onOpenSession?: (session: SessionSummary) => void;
  // Offers a session's menu, as a secondary click on it or VoiceOver's menu command asks.
  onSessionMenu?: (session: SessionSummary) => void;
}

// The sidebar's Sessions section: its heading with New session just after it and, while there are
// folders to choose, the filter just after that; then the sessions, each labelled with its folder,
// which a click or Return shows and whose menu a secondary click offers, of which only the rows in
// view are rendered. The filter narrows the list to the sessions in one folder or below it. Without
// sessions it shows the heading row alone.
export function SessionsSection({
  sessions,
  folders,
  onNewSession,
  onOpenSession,
  onSessionMenu,
}: SessionsSectionProps) {
  const { t } = useTranslation();
  const heading = useId();
  const [filterId, setFilterId] = useState<string | null>(null);
  // A folder that has left the list no longer narrows it.
  const filter = folders.find((folder) => folder.id === filterId);
  const shown =
    filter === undefined ? sessions : sessions.filter((session) => isIn(session.cwd, filter.path));

  return (
    <section aria-labelledby={heading} className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-1 px-2">
        <h2 id={heading} className="shrink-0 text-[11px] text-faint">
          {t('sessions.heading')}
        </h2>
        {/* New session, a plus icon whose name VoiceOver reads and the tooltip shows; the negative
            margin keeps the heading's row height. */}
        <button
          type="button"
          disabled={onNewSession === undefined}
          onClick={onNewSession}
          aria-label={t('sessions.newSession')}
          title={t('sessions.newSession')}
          className="-my-0.5 grid size-5 shrink-0 place-items-center rounded-md text-faint enabled:hover:bg-hover enabled:hover:text-ink"
        >
          <Plus className="size-4" />
        </button>
        {folders.length > 0 && (
          <Select
            label={t('sessions.filter')}
            value={filter?.id ?? ''}
            options={[
              { value: '', label: t('sessions.allWorkspaces') },
              ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
            ]}
            onChange={(value) => {
              setFilterId(value === '' ? null : value);
            }}
          />
        )}
      </div>
      {shown.length > 0 && (
        <SessionRows
          sessions={shown}
          labelledBy={heading}
          className="min-h-0"
          {...(onOpenSession === undefined ? {} : { onOpen: onOpenSession })}
          {...(onSessionMenu === undefined ? {} : { onMenu: onSessionMenu })}
        />
      )}
    </section>
  );
}

interface SessionRowsProps {
  // The sessions, in the order the list shows them.
  sessions: SessionSummary[];
  // The id of what names the list for VoiceOver, such as its heading.
  labelledBy?: string;
  // Sizes the scroll area, such as how tall it may grow.
  className: string;
  // Shows a session; the rows are disabled without it.
  onOpen?: (session: SessionSummary) => void;
  // Offers a session's menu.
  onMenu?: (session: SessionSummary) => void;
  // The id of a dropdown the rows lie in, which a row hides as it shows its session.
  closes?: string;
}

// Session rows in a scroll area of their own, which renders only the rows in view and a few on either
// side, so that a long list costs no more to show than a short one. Each row tells VoiceOver where it
// lies in the whole list, and the row with the keyboard focus stays while it is scrolled out of view,
// keeping the focus.
export function SessionRows({
  sessions,
  labelledBy,
  className,
  onOpen,
  onMenu,
  closes,
}: SessionRowsProps) {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  // The first row in view and how many rows the view holds; none until the area is measured.
  const [view, setView] = useState({ first: 0, rows: 0 });
  // The session whose row has the keyboard focus.
  const [focused, setFocused] = useState<string | null>(null);
  const count = sessions.length;

  // Measured again as the area scrolls or changes size, and as the list's length changes, which can
  // scroll it.
  useLayoutEffect(() => {
    if (area === null) return;
    const measure = () => {
      const first = Math.floor(area.scrollTop / ROW_HEIGHT);
      const rows = Math.ceil(area.clientHeight / ROW_HEIGHT);
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
  }, [area, count]);

  const start = Math.max(0, Math.min(view.first, count) - OVERSCAN);
  const end = Math.min(
    count,
    view.first + (view.rows === 0 ? UNMEASURED_ROWS : view.rows) + OVERSCAN,
  );
  const kept = focused === null ? -1 : sessions.findIndex((session) => session.id === focused);
  const rendered = [
    ...(kept !== -1 && kept < start ? [kept] : []),
    ...Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset),
    ...(kept >= end ? [kept] : []),
  ];

  return (
    // Positioned, so that the statuses for VoiceOver alone stay inside the scroll area.
    <div ref={setArea} className={`relative overflow-y-auto ${className}`}>
      <ul aria-labelledby={labelledBy} className="relative" style={{ height: count * ROW_HEIGHT }}>
        {rendered.map((index) => {
          const session = sessions[index];
          if (session === undefined) return null;
          return (
            <li
              key={session.id}
              aria-setsize={count}
              aria-posinset={index + 1}
              onFocus={() => {
                setFocused(session.id);
              }}
              onBlur={() => {
                setFocused(null);
              }}
              className="absolute inset-x-0"
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <SessionRow
                session={session}
                {...(onOpen === undefined ? {} : { onOpen })}
                {...(onMenu === undefined ? {} : { onMenu })}
                {...(closes === undefined ? {} : { closes })}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface SessionRowProps {
  session: SessionSummary;
  // Shows the session; the row is disabled without it.
  onOpen?: (session: SessionSummary) => void;
  // Offers the session's menu.
  onMenu?: (session: SessionSummary) => void;
  // The id of a dropdown the row lies in, which the row hides as it shows its session.
  closes?: string;
}

// A session as the lists show it, filling its row: its status as a dot and in words for VoiceOver, its
// title or else its provider's name, and its folder's name, with the path in the tooltip. A click or
// Return shows it, and a secondary click or VoiceOver's menu command offers its menu.
function SessionRow({ session, onOpen, onMenu, closes }: SessionRowProps) {
  const { t } = useTranslation();
  const hiding =
    closes === undefined ? {} : ({ popoverTarget: closes, popoverTargetAction: 'hide' } as const);
  return (
    <button
      type="button"
      disabled={onOpen === undefined}
      {...hiding}
      onClick={() => {
        onOpen?.(session);
      }}
      onContextMenu={(event) => {
        if (onMenu === undefined) return;
        event.preventDefault();
        onMenu(session);
      }}
      className="flex h-full w-full items-center gap-2 rounded-md px-2 text-left enabled:hover:bg-hover"
    >
      <StatusDot status={statusDots[session.status]} />
      <span className="sr-only">{t(`sessions.status.${session.status}`)}</span>
      <span className="min-w-0 flex-1 truncate">
        {session.title === undefined || session.title === ''
          ? t(`providers.${session.provider}`)
          : session.title}
      </span>
      <span title={session.cwd} className="max-w-[45%] shrink-0 truncate text-[11px] text-faint">
        {folderName(session.cwd)}
      </span>
    </button>
  );
}

// Whether the path is the folder or lies inside it.
function isIn(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

// The last name in a path, or the path itself for the startup disk's root.
function folderName(path: string): string {
  const name = path.replace(/\/+$/, '').split('/').at(-1);
  return name === undefined || name === '' ? path : name;
}
