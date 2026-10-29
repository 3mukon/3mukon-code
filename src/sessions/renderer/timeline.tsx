import { useTranslation } from 'react-i18next';
import { StatusDot, type Status } from '../../ui/renderer/status-dot';
import type { Task, ToolStatus } from '../shared/events';
import type { SessionState, SessionStatus, TimelineItem } from '../shared/session-state';
import { Markdown } from './markdown';

// How a session's status shows as a dot: a closed session as done.
export const statusDots: Record<SessionStatus, Status> = {
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  closed: 'done',
};

const toolDots: Record<ToolStatus, Status> = {
  pending: 'idle',
  running: 'running',
  completed: 'done',
  failed: 'idle',
};

const taskDots: Record<Task['status'], Status> = {
  pending: 'idle',
  in_progress: 'running',
  completed: 'done',
};

interface TimelineProps {
  // The session's state, or null before it has one.
  state: SessionState | null;
  // A first message on its way, shown as the prompt while the session starts.
  starting?: string;
}

// A session's activity, as the reference's panes show it: the user's messages as prompts, the agent's
// as Markdown, its thinking quieter, its tool calls and file changes as rows with their state, the
// approvals and questions waiting for the user, errors, then the agent's task list with finished rows
// struck through and the current one bright, and Working while a turn runs.
export function Timeline({ state, starting }: TimelineProps) {
  const { t } = useTranslation();
  const working = starting !== undefined || state?.turnRunning === true;
  return (
    <>
      {starting !== undefined && <Prompt text={starting} />}
      {state?.timeline.map((item, index) => (
        <Item key={keyOf(item, index)} item={item} />
      ))}
      {state !== null && state.tasks.length > 0 && (
        <ul className="my-3">
          {state.tasks.map((task, index) => (
            <li
              key={`${String(index)}:${task.text}`}
              className={`flex items-baseline gap-3 ${taskLook[task.status]}`}
            >
              <span className="-translate-y-0.5">
                <StatusDot status={taskDots[task.status]} />
              </span>
              <span className="min-w-0">{task.text}</span>
            </li>
          ))}
        </ul>
      )}
      {working && (
        <p className="mt-3 text-faint after:animate-blink after:content-['…'] motion-reduce:after:animate-none">
          {t('sessions.page.working')}
        </p>
      )}
      {state?.closed === true && <p className="mt-3 text-faint">{t('sessions.page.ended')}</p>}
    </>
  );
}

const taskLook: Record<Task['status'], string> = {
  pending: '',
  in_progress: 'text-ink',
  completed: 'text-faint line-through decoration-line',
};

function Item({ item }: { item: TimelineItem }) {
  const { t } = useTranslation();
  switch (item.type) {
    case 'message':
      if (item.role === 'user') return <Prompt text={item.text} />;
      if (item.role === 'thinking') {
        return <p className="my-3 whitespace-pre-wrap text-faint italic">{item.text}</p>;
      }
      return (
        <div className="my-3 text-ink">
          <Markdown text={item.text} />
        </div>
      );
    case 'tool':
      return (
        <Row status={toolDots[item.status]} failed={item.status === 'failed'}>
          {item.title === '' ? (item.command ?? item.kind) : item.title}
        </Row>
      );
    case 'file-change': {
      const { added, removed } = linesChanged(item.change.diff);
      return (
        <p className="my-0.5 flex min-w-0 gap-2">
          <span className="min-w-0 truncate text-ink">
            {item.change.newPath ?? item.change.path}
          </span>
          <span className="text-add">+{added}</span>
          <span className="text-del">−{removed}</span>
        </p>
      );
    }
    case 'approval':
    case 'question': {
      const waiting = item.resolution === undefined;
      const title = item.type === 'approval' ? item.request.title : undefined;
      return (
        <Row status={waiting ? 'waiting' : 'done'}>
          {title ??
            t(item.type === 'approval' ? 'sessions.page.approval' : 'sessions.page.question')}
        </Row>
      );
    }
    case 'error':
      return (
        <p className="my-3 whitespace-pre-wrap text-del">
          {item.message ?? t('sessions.page.failed')}
        </p>
      );
  }
}

function Prompt({ text }: { text: string }) {
  return <p className="my-4 whitespace-pre-wrap text-ink first:mt-0">{text}</p>;
}

function Row({
  status,
  failed = false,
  children,
}: {
  status: Status;
  failed?: boolean;
  children: string;
}) {
  return (
    <p className={`my-0.5 flex min-w-0 items-baseline gap-3 ${failed ? 'text-del' : ''}`}>
      <span className="-translate-y-0.5">
        <StatusDot status={status} />
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </p>
  );
}

function keyOf(item: TimelineItem, index: number): string {
  switch (item.type) {
    case 'message':
    case 'tool':
      return `${item.type}:${item.id}`;
    case 'file-change':
      return `file:${item.change.id}`;
    case 'approval':
    case 'question':
      return `${item.type}:${item.request.id}`;
    case 'error':
      return `error:${String(index)}`;
  }
}

// How many lines a unified diff adds and removes, leaving out its file headers.
export function linesChanged(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}
