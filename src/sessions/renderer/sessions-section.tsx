import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus } from '../../ui/renderer/icons';
import { StatusDot, type Status } from '../../ui/renderer/status-dot';
import type { SessionStatus } from '../shared/session-state';
import type { SessionSummary } from '../shared/sessions';

// A folder the list can be narrowed to, such as a workspace.
export interface SessionFolder {
  id: string;
  name: string;
  path: string;
}

interface SessionsSectionProps {
  // Newest first.
  sessions: SessionSummary[];
  // The folders the filter offers, in order.
  folders: SessionFolder[];
}

const dots: Record<SessionStatus, Status> = {
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  closed: 'done',
};

// The sidebar's Sessions section: its heading with New session just after it and, while there are
// folders to choose, the filter at the row's end; then every session, each labelled with its folder.
// The filter narrows the list to the sessions in one folder or below it. Without sessions it shows the
// heading row alone.
export function SessionsSection({ sessions, folders }: SessionsSectionProps) {
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
        <h2 id={heading} className="text-[11px] text-faint">
          {t('sessions.heading')}
        </h2>
        {/* New session, a plus icon whose name VoiceOver reads and the tooltip shows; the negative
            margin keeps the heading's row height. It opens session pages once they exist. */}
        <button
          type="button"
          disabled
          aria-label={t('sessions.newSession')}
          title={t('sessions.newSession')}
          className="-my-0.5 grid size-5 place-items-center rounded-md text-faint"
        >
          <Plus className="size-4" />
        </button>
        {folders.length > 0 && (
          <div className="relative ml-auto flex min-w-0 items-center">
            <select
              aria-label={t('sessions.filter')}
              title={t('sessions.filter')}
              value={filter?.id ?? ''}
              onChange={(event) => {
                setFilterId(event.target.value === '' ? null : event.target.value);
              }}
              className="max-w-[120px] min-w-0 appearance-none truncate rounded-md bg-transparent pr-4 pl-1 text-right text-[11px] text-faint hover:text-ink"
            >
              <option value="">{t('sessions.allWorkspaces')}</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 size-3 text-faint" />
          </div>
        )}
      </div>
      {shown.length > 0 && (
        <ul aria-labelledby={heading} className="min-h-0 overflow-y-auto">
          {shown.map((session) => (
            <li key={session.id} className="flex h-7 items-center gap-2 rounded-md px-2">
              <StatusDot status={dots[session.status]} />
              <span className="sr-only">{t(`sessions.status.${session.status}`)}</span>
              <span className="min-w-0 flex-1 truncate">
                {session.title === undefined || session.title === ''
                  ? t(`providers.${session.provider}`)
                  : session.title}
              </span>
              <span
                title={session.cwd}
                className="max-w-[45%] shrink-0 truncate text-[11px] text-faint"
              >
                {folderName(session.cwd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
