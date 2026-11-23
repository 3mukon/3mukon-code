import { useId, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search } from '../../ui/renderer/icons';
import { SearchField } from '../../ui/renderer/search-field';
import { Select } from '../../ui/renderer/select';
import { StatusDot } from '../../ui/renderer/status-dot';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';
import { folderName, useReadAhead, useVisibleRows } from './rows';
import { statusDots } from './timeline';
import { useSessionSearch } from './use-search';

// The height of a session's row, in pixels, by which the list lays out its rows.
export const ROW_HEIGHT = 28;

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
  // What searches the sessions' titles and conversations, as the main process holds them.
  bridge: Pick<SessionsBridge, 'search'>;
  // Opens a new session page; New session stays disabled without it.
  onNewSession?: () => void;
  // Shows a session, as a click on it in the list asks.
  onOpenSession?: (session: SessionSummary) => void;
  // Offers a session's menu, as a secondary click on it or VoiceOver's menu command asks.
  onSessionMenu?: (session: SessionSummary) => void;
  // A press on a session's row, which whoever composes the section may follow to drag the session
  // elsewhere.
  onPressSession?: (session: SessionSummary, press: PointerEvent<HTMLElement>) => void;
  // Reads a session's history ahead of showing it.
  onReadAhead?: (session: SessionSummary) => void;
}

// The sidebar's Sessions section: its heading with New session just after it, then, while there are
// folders to choose, the filter, and a magnifying glass that opens a search field in the filter's
// place; then the sessions, each child indented beneath its parent, each labelled with its folder,
// which a click or Return shows, whose presses go to whoever drags them elsewhere and whose menu a
// secondary click offers, of which only the rows in view are rendered. The filter narrows the list
// to the sessions in one folder or below it, and a search narrows it further, as the main process
// answers, to the sessions whose title or conversation holds every word of the query, saying how
// many sessions it has yet to read, or, once it knows, that none match. Escape, or leaving the
// field empty, closes the search. The heading's row keeps its height whatever it shows, its items
// on one centre line. Without sessions the section shows the heading row alone.
export function SessionsSection({
  sessions,
  folders,
  bridge,
  onNewSession,
  onOpenSession,
  onSessionMenu,
  onPressSession,
  onReadAhead,
}: SessionsSectionProps) {
  const { t } = useTranslation();
  const heading = useId();
  const [filterId, setFilterId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // A folder that has left the list no longer narrows it.
  const filter = folders.find((folder) => folder.id === filterId);
  const inFolder =
    filter === undefined ? sessions : sessions.filter((session) => isIn(session.cwd, filter.path));
  const found = useSessionSearch(bridge, inFolder, searchOpen ? query : '', false);
  const closeSearch = () => {
    setQuery('');
    setSearchOpen(false);
  };

  return (
    <section aria-labelledby={heading} className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-1 px-2">
        <h2 id={heading} className="shrink-0 text-[11px] text-faint">
          {t('sessions.heading')}
        </h2>
        {/* New session, a plus icon whose name VoiceOver reads and the tooltip shows; the negative
            margins of the row's buttons and search field keep the heading's row height. */}
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
        {searchOpen ? (
          <SearchField
            compact
            autoFocus
            label={t('sessions.search.open')}
            placeholder={
              filter === undefined
                ? t('sessions.search.placeholder')
                : t('sessions.search.placeholderIn', { folder: filter.name })
            }
            value={query}
            onChange={setQuery}
            onClose={closeSearch}
            clearLabel={t('sessions.search.clear')}
          />
        ) : (
          <>
            {folders.length > 0 && (
              <Select
                label={t('sessions.filter')}
                value={filter?.id ?? ''}
                options={[
                  // "All" where the filter sits, to leave the magnifying glass room beside it.
                  { value: '', label: t('sessions.allWorkspaces'), short: t('sessions.all') },
                  ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
                ]}
                onChange={(value) => {
                  setFilterId(value === '' ? null : value);
                }}
              />
            )}
            <button
              type="button"
              onClick={() => {
                setSearchOpen(true);
              }}
              aria-label={t('sessions.search.open')}
              title={t('sessions.search.open')}
              className="-my-0.5 grid size-5 shrink-0 place-items-center rounded-md text-faint hover:bg-hover hover:text-ink"
            >
              <Search className="size-3.5" />
            </button>
          </>
        )}
      </div>
      {found.searching && found.unread > 0 && (
        <p role="status" className="px-2 text-[11px] text-faint">
          {t('sessions.search.unread', { count: found.unread })}
        </p>
      )}
      {found.none && <p className="px-2 text-[11px] text-faint">{t('sessions.search.none')}</p>}
      {found.sessions.length > 0 && (
        <SessionRows
          rows={nested(found.sessions)}
          labelledBy={heading}
          className="min-h-0"
          {...(onOpenSession === undefined ? {} : { onOpen: onOpenSession })}
          {...(onSessionMenu === undefined ? {} : { onMenu: onSessionMenu })}
          {...(onPressSession === undefined ? {} : { onPress: onPressSession })}
          {...(onReadAhead === undefined ? {} : { onReadAhead })}
        />
      )}
    </section>
  );
}

// A session's row: the session, and how deep it lies, 1 for a child beneath its parent.
interface Row {
  session: SessionSummary;
  depth: 0 | 1;
}

// The sessions in the list's order, each child beneath its parent, indented, where both are shown,
// the children following their parent in the list's order, and otherwise on its own (ADR-0036).
function nested(sessions: readonly SessionSummary[]): Row[] {
  const shown = new Set(sessions.map((session) => session.id));
  const beneath = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (session.parent === undefined || !shown.has(session.parent)) continue;
    beneath.set(session.parent, [...(beneath.get(session.parent) ?? []), session]);
  }
  return sessions.flatMap((session): Row[] =>
    session.parent !== undefined && shown.has(session.parent)
      ? []
      : [
          { session, depth: 0 },
          ...(beneath.get(session.id) ?? []).map((child) => ({
            session: child,
            depth: 1 as const,
          })),
        ],
  );
}

interface SessionRowsProps {
  // The sessions' rows, in the order the list shows them.
  rows: Row[];
  // The id of what names the list for VoiceOver, such as its heading.
  labelledBy?: string;
  // Sizes the scroll area, such as how tall it may grow.
  className: string;
  // Shows a session; the rows are disabled without it.
  onOpen?: (session: SessionSummary) => void;
  // Offers a session's menu.
  onMenu?: (session: SessionSummary) => void;
  // A press on a session's row, which may become a drag elsewhere.
  onPress?: (session: SessionSummary, press: PointerEvent<HTMLElement>) => void;
  // Reads a session's history ahead of showing it.
  onReadAhead?: (session: SessionSummary) => void;
}

// Session rows in a scroll area of their own, which renders only the rows in view and a few on either
// side, so that a long list costs no more to show than a short one. Each row tells VoiceOver where it
// lies in the whole list, and the row with the keyboard focus stays while it is scrolled out of view,
// keeping the focus.
function SessionRows({
  rows,
  labelledBy,
  className,
  onOpen,
  onMenu,
  onPress,
  onReadAhead,
}: SessionRowsProps) {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  // The session whose row has the keyboard focus.
  const [focused, setFocused] = useState<string | null>(null);
  const count = rows.length;
  const kept = focused === null ? -1 : rows.findIndex((row) => row.session.id === focused);
  const rendered = useVisibleRows(area, count, ROW_HEIGHT, kept);

  return (
    // Positioned, so that the statuses for VoiceOver alone stay inside the scroll area.
    <div ref={setArea} className={`relative overflow-y-auto ${className}`}>
      <ul aria-labelledby={labelledBy} className="relative" style={{ height: count * ROW_HEIGHT }}>
        {rendered.map((index) => {
          const row = rows[index];
          if (row === undefined) return null;
          const { session, depth } = row;
          return (
            <li
              key={session.id}
              aria-setsize={count}
              aria-posinset={index + 1}
              aria-level={depth + 1}
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
                depth={depth}
                {...(onOpen === undefined ? {} : { onOpen })}
                {...(onMenu === undefined ? {} : { onMenu })}
                {...(onPress === undefined ? {} : { onPress })}
                {...(onReadAhead === undefined ? {} : { onReadAhead })}
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
  // 1 for a child beneath its parent, which the row indents.
  depth?: 0 | 1;
  // Shows the session; the row is disabled without it.
  onOpen?: (session: SessionSummary) => void;
  // Offers the session's menu.
  onMenu?: (session: SessionSummary) => void;
  // A press on the row, which may become a drag elsewhere.
  onPress?: (session: SessionSummary, press: PointerEvent<HTMLElement>) => void;
  // Reads the session's history ahead of showing it.
  onReadAhead?: (session: SessionSummary) => void;
}

// A session as the list shows it, filling its row: its status as a dot and in words for VoiceOver, its
// title or else its provider's name, and its folder's name, with the path in the tooltip. A click or
// Return shows it, a press goes to whoever drags it elsewhere, and a secondary click or VoiceOver's
// menu command offers its menu. The history of a session that is not running is read ahead as the
// user reaches for the row.
function SessionRow({ session, depth = 0, onOpen, onMenu, onPress, onReadAhead }: SessionRowProps) {
  const { t } = useTranslation();
  const readAhead = useReadAhead(session, onReadAhead);
  return (
    <button
      type="button"
      disabled={onOpen === undefined}
      onPointerDown={(event) => {
        readAhead.now();
        onPress?.(session, event);
      }}
      onPointerEnter={readAhead.soon}
      onPointerLeave={readAhead.never}
      onFocus={readAhead.soon}
      onBlur={readAhead.never}
      onClick={() => {
        onOpen?.(session);
      }}
      onContextMenu={(event) => {
        if (onMenu === undefined) return;
        event.preventDefault();
        onMenu(session);
      }}
      className={`flex h-full w-full items-center gap-2 rounded-md pr-2 text-left enabled:hover:bg-hover ${depth === 1 ? 'pl-6' : 'pl-2'}`}
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
