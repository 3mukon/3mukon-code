import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ArchiveRestore, Trash } from '../../ui/renderer/icons';
import { SearchField } from '../../ui/renderer/search-field';
import { StatusDot } from '../../ui/renderer/status-dot';
import { searchWords } from '../shared/search';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';
import { folderName, useReadAhead, useVisibleRows } from './rows';
import { statusDots } from './timeline';
import { useSessionSearch } from './use-search';

// The height of an archived session's row, in pixels: two lines.
const ROW_HEIGHT = 48;
// How often, in milliseconds, the rows say again how long ago their sessions were active.
const CLOCK = 60_000;

// What can be done to an archived session from its row.
export type ArchivedAction = 'unarchive' | 'remove';

interface ArchivedButtonProps {
  // How many sessions are archived.
  count: number;
  // Opens the archived sessions' panel, or focuses it.
  onOpen: () => void;
}

// The archived sessions' button, for the title bar: an archive icon, named in its tooltip and for
// VoiceOver, which opens their panel. Without archived sessions it keeps its place, disabled.
export function ArchivedButton({ count, onOpen }: ArchivedButtonProps) {
  const { t } = useTranslation();
  const label = t('sessions.archived');
  return (
    <button
      type="button"
      disabled={count === 0}
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] enabled:hover:bg-hover enabled:hover:text-ink"
    >
      <Archive className="size-3.5" />
    </button>
  );
}

interface ArchivedPanelProps {
  // What loads and searches the archived sessions.
  bridge: Pick<SessionsBridge, 'archived' | 'search'>;
  // How many sessions are archived; the panel loads them again whenever that changes.
  count: number;
  // Shows a session, as a click on its row asks.
  onOpenSession: (session: SessionSummary) => void;
  // Offers a session's menu, as a secondary click on its row asks.
  onSessionMenu: (session: SessionSummary) => void;
  // Unarchives a session, or removes it from the list once the user confirms, from its row.
  onAct: (session: SessionSummary, action: ArchivedAction) => void;
  // Reads a session's history ahead of showing it.
  onReadAhead?: (session: SessionSummary) => void;
}

// The archived sessions, as a panel of their own shows them on the window's paper: a search field at
// the top, which finds them by title or conversation as the Sessions list's does, then the sessions,
// the most recently active first, of which only the rows in view are rendered. Each row shows the
// session's status, its title or else its provider's name, and how long ago it was last active, and
// under them its folder and provider or, while a search matches its conversation, the passage that
// matched, the query's words in ink. A click or Return shows the session and a secondary click
// offers its menu; the pointer or the keyboard focus on a row brings out Unarchive and Remove from
// List. The panel says when there are no archived sessions, none that match, or how many it has yet
// to read for searching.
export function ArchivedPanel({
  bridge,
  count,
  onOpenSession,
  onSessionMenu,
  onAct,
  onReadAhead,
}: ArchivedPanelProps) {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const found = useSessionSearch(bridge, sessions ?? [], query, true);
  const now = useClock();

  useEffect(() => {
    let current = true;
    bridge.archived().then(
      (loaded) => {
        if (current) setSessions(loaded);
      },
      (error: unknown) => {
        console.error('The archived sessions could not be loaded:', error);
      },
    );
    return () => {
      current = false;
    };
  }, [bridge, count]);

  const notice =
    sessions === null
      ? null
      : sessions.length === 0
        ? t('sessions.archivedPanel.empty')
        : found.none
          ? t('sessions.archivedPanel.none')
          : null;

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr]">
      <div className="flex flex-col gap-1.5 px-4 pt-2 pb-2">
        <SearchField
          label={t('sessions.archivedPanel.search')}
          placeholder={t('sessions.search.placeholder')}
          value={query}
          onChange={setQuery}
          clearLabel={t('sessions.search.clear')}
        />
        {found.searching && found.unread > 0 && (
          <p role="status" className="px-1 text-[11px] text-faint">
            {t('sessions.search.unread', { count: found.unread })}
          </p>
        )}
        {notice !== null && <p className="px-1 text-[11px] text-faint">{notice}</p>}
      </div>
      <ArchivedRows
        sessions={found.sessions}
        snippets={found.snippets}
        words={searchWords(query)}
        now={now}
        language={i18n.language}
        onOpen={onOpenSession}
        onMenu={onSessionMenu}
        onAct={onAct}
        {...(onReadAhead === undefined ? {} : { onReadAhead })}
      />
    </div>
  );
}

interface ArchivedRowsProps {
  sessions: SessionSummary[];
  snippets: ReadonlyMap<string, string>;
  words: readonly string[];
  now: number;
  language: string;
  onOpen: (session: SessionSummary) => void;
  onMenu: (session: SessionSummary) => void;
  onAct: (session: SessionSummary, action: ArchivedAction) => void;
  onReadAhead?: (session: SessionSummary) => void;
}

// The rows in a scroll area of their own, which renders only those in view and a few on either side;
// each tells VoiceOver where it lies in the whole list, and the row with the keyboard focus stays
// while it is scrolled out of view.
function ArchivedRows({ sessions, ...row }: ArchivedRowsProps) {
  const { t } = useTranslation();
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const count = sessions.length;
  const kept = focused === null ? -1 : sessions.findIndex((session) => session.id === focused);
  const rendered = useVisibleRows(area, count, ROW_HEIGHT, kept);
  return (
    // Positioned, so that the statuses for VoiceOver alone stay inside the scroll area (L-0001).
    <div ref={setArea} className="relative min-h-0 overflow-y-auto px-2 pb-2">
      <ul
        aria-label={t('sessions.archived')}
        className="relative"
        style={{ height: count * ROW_HEIGHT }}
      >
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
              <ArchivedRow session={session} {...row} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ArchivedRow({
  session,
  snippets,
  words,
  now,
  language,
  onOpen,
  onMenu,
  onAct,
  onReadAhead,
}: Omit<ArchivedRowsProps, 'sessions'> & { session: SessionSummary }) {
  const { t } = useTranslation();
  const readAhead = useReadAhead(session, onReadAhead);
  const snippet = snippets.get(session.id);
  const provider = t(`providers.${session.provider}`);
  const title = session.title === undefined || session.title === '' ? provider : session.title;
  return (
    <div className="group relative h-full">
      <button
        type="button"
        onPointerDown={readAhead.now}
        onPointerEnter={readAhead.soon}
        onPointerLeave={readAhead.never}
        onFocus={readAhead.soon}
        onBlur={readAhead.never}
        onClick={() => {
          onOpen(session);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(session);
        }}
        className="flex h-full w-full flex-col justify-center gap-0.5 rounded-md px-2 text-left hover:bg-hover"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <StatusDot status={statusDots[session.status]} />
          <span className="sr-only">{t(`sessions.status.${session.status}`)}</span>
          <span className="min-w-0 flex-1 truncate text-ink">{title}</span>
          <span className="shrink-0 text-[11px] text-faint group-focus-within:invisible group-hover:invisible">
            {activityOf(session.activeAt, now, language)}
          </span>
        </span>
        <span title={session.cwd} className="w-full truncate pl-4 text-[11px] text-faint">
          {snippet === undefined ? (
            `${folderName(session.cwd)} · ${provider}`
          ) : (
            <Passage text={snippet} words={words} />
          )}
        </span>
      </button>
      <div className="absolute top-1.5 right-2 hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
        <RowAction
          label={t('sessions.menu.unarchive')}
          onClick={() => {
            onAct(session, 'unarchive');
          }}
        >
          <ArchiveRestore className="size-3.5" />
        </RowAction>
        <RowAction
          label={t('sessions.menu.remove')}
          onClick={() => {
            onAct(session, 'remove');
          }}
        >
          <Trash className="size-3.5" />
        </RowAction>
      </div>
    </div>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-5 place-items-center rounded-md text-faint hover:paper hover:text-ink"
    >
      {children}
    </button>
  );
}

// A passage of a conversation, with the query's words in ink.
function Passage({ text, words }: { text: string; words: readonly string[] }) {
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="text-ink">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The time now, again every minute, which the rows say how long ago their sessions were active from.
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

// How long ago a session was last active, in the window's language: now, or minutes, hours or days
// ago within a week, and beyond, its date, with its year when that is not this year's.
function activityOf(activeAt: number, now: number, language: string): string {
  const seconds = Math.round((activeAt - now) / 1000);
  const distance = Math.abs(seconds);
  const relative = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (distance < 60) return relative.format(0, 'second');
  if (distance < 3_600) return relative.format(Math.round(seconds / 60), 'minute');
  if (distance < 86_400) return relative.format(Math.round(seconds / 3_600), 'hour');
  if (distance < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  const date = new Date(activeAt);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(
    language,
    thisYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  ).format(date);
}
