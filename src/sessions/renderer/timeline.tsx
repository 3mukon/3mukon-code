import { useTranslation } from 'react-i18next';
import { StatusDot, type Status } from '../../ui/renderer/status-dot';
import type { ReactNode } from 'react';
import type { MessageImage, Task } from '../shared/events';
import {
  openRequests,
  type RequestItem,
  type Retrying,
  type SessionState,
  type SessionStatus,
  type TimelineItem,
} from '../shared/session-state';
import { Message } from './message';
import { FileChangeEntry, ToolCall } from './tool-call';

// Shows an approval or a question where it stands in the activity, as whoever composes the page
// decides, and tells whether it is the session's oldest waiting request; the approvals module shows
// it, with what answers it.
export type RenderRequest = (item: RequestItem, place: { oldestWaiting: boolean }) => ReactNode;

// How a session's status shows as a dot: a closed session as done.
export const statusDots: Record<SessionStatus, Status> = {
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  closed: 'done',
};

const taskDots: Record<Task['status'], Status> = {
  pending: 'idle',
  in_progress: 'running',
  completed: 'done',
};

interface TimelineProps {
  // The session's state, or null before it has one.
  state: SessionState | null;
  // The first of the activity's items to render, the page rendering a long activity's last items
  // first; all of them without it.
  from?: number;
  // A message on its way, with its images, shown as the user's after the activity while the session
  // starts or resumes.
  pending?: { text: string; images: MessageImage[] };
  // The provider's name, which VoiceOver reads before each of the agent's messages.
  agent: string;
  renderRequest?: RenderRequest;
}

// A session's activity, oldest first, as the reference's panes show it: the messages (Message), the
// user's at the right and the agent's at the left, so that the two never read alike, and the agent's
// thinking quieter; each tool call as one entry, with the files it changed and their diffs; the
// approvals and questions, as the page's composer renders them; errors, then the agent's task list
// with finished rows struck through and the current one bright, and Working while a turn runs, with
// the provider's retry of a failed request to the model under it while it retries.
export function Timeline({ state, from = 0, pending, agent, renderRequest }: TimelineProps) {
  const { t } = useTranslation();
  const working = pending !== undefined || state?.turnRunning === true;
  const oldestWaiting = state === null ? undefined : openRequests(state)[0]?.id;
  return (
    <>
      {state?.timeline.slice(from).map((item, index) => (
        <Item
          key={keyOf(item, from + index)}
          item={item}
          agent={agent}
          oldestWaiting={oldestWaiting}
          {...(renderRequest === undefined ? {} : { renderRequest })}
        />
      ))}
      {pending !== undefined && (
        <Message role="user" text={pending.text} images={pending.images} agent={agent} />
      )}
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
      {working && state?.retrying !== undefined && <RetryNotice retrying={state.retrying} />}
    </>
  );
}

// Which retry the provider makes, of how many where it says, and why, in the provider's words, which
// show on at most three lines here and whole in the tooltip.
function RetryNotice({ retrying: { attempt, maxRetries, reason } }: { retrying: Retrying }) {
  const { t } = useTranslation();
  const retry =
    maxRetries === undefined
      ? t('sessions.page.retrying', { attempt })
      : t('sessions.page.retryingOf', { attempt, max: maxRetries });
  return (
    <p className="line-clamp-3 wrap-anywhere text-faint" title={reason}>
      {reason === undefined ? retry : t('sessions.page.retryReason', { retry, reason })}
    </p>
  );
}

const taskLook: Record<Task['status'], string> = {
  pending: '',
  in_progress: 'text-ink',
  completed: 'text-faint line-through decoration-line',
};

function Item({
  item,
  agent,
  oldestWaiting,
  renderRequest,
}: {
  item: TimelineItem;
  agent: string;
  // The id of the session's oldest waiting request, if any.
  oldestWaiting: string | undefined;
  renderRequest?: RenderRequest;
}) {
  const { t } = useTranslation();
  switch (item.type) {
    case 'message':
      return <Message role={item.role} text={item.text} images={item.images} agent={agent} />;
    case 'tool':
      return <ToolCall item={item} />;
    case 'file-change':
      return <FileChangeEntry change={item.change} />;
    case 'approval':
    case 'question':
      return renderRequest?.(item, { oldestWaiting: item.request.id === oldestWaiting }) ?? null;
    case 'error':
      return (
        <p className="my-3 whitespace-pre-wrap text-del">
          {item.message ?? t('sessions.page.failed')}
        </p>
      );
  }
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
