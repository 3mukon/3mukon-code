import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from '../../ui/renderer/icons';
import { Select } from '../../ui/renderer/select';
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
// folders to choose, the filter just after that; then every session, each labelled with its folder.
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
        <h2 id={heading} className="shrink-0 text-[11px] text-faint">
          {t('sessions.heading')}
        </h2>
        {/* New session, a plus icon whose name VoiceOver reads and the tooltip shows; the negative
            margin keeps the heading's row height. It opens session pages once they exist. */}
        <button
          type="button"
          disabled
          aria-label={t('sessions.newSession')}
          title={t('sessions.newSession')}
          className="-my-0.5 grid size-5 shrink-0 place-items-center rounded-md text-faint"
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
