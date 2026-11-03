import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive } from '../../ui/renderer/icons';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';
import { ROW_HEIGHT, SessionRows } from './sessions-section';

// How tall the dropdown's list grows before it scrolls.
const LIST_HEIGHT = 'max-h-80';

interface ArchivedSessionsProps {
  // What loads the archived sessions.
  bridge: Pick<SessionsBridge, 'archived'>;
  // How many sessions are archived.
  count: number;
  // Shows a session, as a click on it in the list asks.
  onOpenSession: (session: SessionSummary) => void;
  // Offers a session's menu, which unarchives or removes it.
  onSessionMenu: (session: SessionSummary) => void;
}

// The archived sessions, for the title bar: a button whose dropdown, a sheet of the window's paper as
// the ui module draws one, lists them as the Sessions list shows its own, loaded from the main process
// only as it opens. A session clicked there shows, as the dropdown closes, and its menu unarchives or
// removes it. Without archived sessions the button keeps its place, disabled, and the dropdown, there
// only while there are some, closes.
export function ArchivedSessions({
  bridge,
  count,
  onOpenSession,
  onSessionMenu,
}: ArchivedSessionsProps) {
  const { t } = useTranslation();
  const dropdown = useId();
  const label = t('sessions.archived');

  return (
    <>
      <button
        type="button"
        popoverTarget={dropdown}
        disabled={count === 0}
        aria-label={label}
        title={label}
        className="grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] enabled:hover:bg-hover enabled:hover:text-ink"
      >
        <Archive className="size-3.5" />
      </button>
      {count > 0 && (
        <ArchivedDropdown
          id={dropdown}
          label={label}
          bridge={bridge}
          count={count}
          onOpenSession={onOpenSession}
          onSessionMenu={onSessionMenu}
        />
      )}
    </>
  );
}

interface ArchivedDropdownProps extends ArchivedSessionsProps {
  id: string;
  label: string;
}

// The dropdown, which loads the archived sessions as it opens, and again while it stays open whenever
// how many there are changes, and lets them go as it closes. While they load it is as tall as their
// list will be.
function ArchivedDropdown({
  id,
  label,
  bridge,
  count,
  onOpenSession,
  onSessionMenu,
}: ArchivedDropdownProps) {
  const [open, setOpen] = useState(false);
  // The archived sessions, the most recently active first, once loaded.
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [bridge, open, count]);

  return (
    // Its own weight, since the dropdown takes its type from wherever the button lies, such as a
    // panel's header, and out of the title bar's drag area, which it may overlap.
    <div
      id={id}
      popover="auto"
      role="group"
      aria-label={label}
      onToggle={(event) => {
        const opened = event.newState === 'open';
        setOpen(opened);
        if (!opened) setSessions(null);
      }}
      className="inset-auto m-0 mt-1 w-64 max-w-[calc(100vw-16px)] rounded-md border border-dashed border-menu-line paper p-1 font-normal [-webkit-app-region:no-drag] [position-area:bottom_span-right] [position-try-fallbacks:flip-inline]"
    >
      {sessions === null ? (
        <div aria-busy="true" className={LIST_HEIGHT} style={{ height: count * ROW_HEIGHT }} />
      ) : (
        <SessionRows
          sessions={sessions}
          className={LIST_HEIGHT}
          onOpen={onOpenSession}
          onMenu={onSessionMenu}
          closes={id}
        />
      )}
    </div>
  );
}
