import { createContext, memo, useContext, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox } from '../../ui/renderer/icons';
import { StatusDot, type Status } from '../../ui/renderer/status-dot';
import type { MessageImage, Task } from '../shared/events';
import type { InboxNotice } from '../shared/inbox';
import {
  openRequests,
  type RequestItem,
  type Retrying,
  type SessionState,
  type SessionStatus,
  type TimelineItem,
  type ToolItem,
} from '../shared/session-state';
import { Message } from './message';
import { FileChangeEntry, ToolCall } from './tool-call';

// Shows an approval or a question where it stands in the activity, as whoever composes the page
// decides, and tells whether it is the session's oldest waiting request; the approvals module shows
// it, with what answers it.
export type RenderRequest = (item: RequestItem, place: { oldestWaiting: boolean }) => ReactNode;

// What whoever composes the page shows under a tool call, by the provider's id for the call, such as
// what the app's own tools did, or nothing.
export type RenderToolExtra = (toolId: string) => ReactNode;

// What whoever composes the page shows in place of a tool call's own entry, such as what the app's
// browser and computer tools did, which the provider's entry names only by the tool; undefined keeps
// the provider's entry.
export type RenderToolCall = (item: ToolItem) => ReactNode;

// The extras reach each tool call's entry through the context, so that what they show changing renders
// only the extras again, never the entries, which render again only as their own items change.
const ToolExtras = createContext<RenderToolExtra | undefined>(undefined);
const ToolCalls = createContext<RenderToolCall | undefined>(undefined);

function ToolExtra({ id }: { id: string }) {
  return useContext(ToolExtras)?.(id) ?? null;
}

function ToolEntry({ item }: { item: ToolItem }) {
  const own = useContext(ToolCalls)?.(item);
  return own === undefined ? <ToolCall item={item} /> : own;
}

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
  // For a child session, its parent's title, which names the sender of its first message, the task
  // its parent gave it, in place of the user (ADR-0036).
  firstFrom?: string;
  renderRequest?: RenderRequest;
  renderToolExtra?: RenderToolExtra;
  renderToolCall?: RenderToolCall;
  // What waits on the user apart from the provider's own requests, such as the approval the app asks
  // for an operation of its tools, after the activity's items, where the provider's would be.
  hostRequests?: ReactNode;
}

// A session's activity, oldest first, as the reference's panes show it: the messages (Message), the
// user's at the right and the agent's at the left, so that the two never read alike, and the agent's
// thinking quieter; each tool call as one entry, with the files it changed and their diffs; the
// approvals and questions, as the page's composer renders them, and under a tool call, or in place of
// its entry, what whoever composes the page gives it; errors, then the agent's task list
// with finished rows struck through and the current one bright, and Working while a turn runs, with
// the provider's retry of a failed request to the model under it while it retries.
export function Timeline({
  state,
  from = 0,
  pending,
  agent,
  firstFrom,
  renderRequest,
  renderToolExtra,
  renderToolCall,
  hostRequests,
}: TimelineProps) {
  const { t } = useTranslation();
  const working = pending !== undefined || state?.turnRunning === true;
  const oldestWaiting = state === null ? undefined : openRequests(state)[0]?.id;
  const first =
    firstFrom === undefined
      ? undefined
      : state?.timeline.find((item) => item.type === 'message' && item.role === 'user');
  return (
    <ToolExtras.Provider value={renderToolExtra}>
      <ToolCalls.Provider value={renderToolCall}>
        {state?.timeline.slice(from).map((item, index) => (
          <Item
            key={keyOf(item, from + index)}
            item={item}
            agent={agent}
            oldestWaiting={oldestWaiting}
            {...(item === first && firstFrom !== undefined ? { from: firstFrom } : {})}
            {...(renderRequest === undefined ? {} : { renderRequest })}
          />
        ))}
        {pending !== undefined && (
          <Message role="user" text={pending.text} images={pending.images} agent={agent} />
        )}
        {hostRequests}
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
      </ToolCalls.Provider>
    </ToolExtras.Provider>
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

interface ItemProps {
  item: TimelineItem;
  agent: string;
  // Another session's title, for a message in the user's place that it sent.
  from?: string;
  // The id of the session's oldest waiting request, if any.
  oldestWaiting: string | undefined;
  renderRequest?: RenderRequest;
}

// Whether an entry renders as it did: its item, which streamed events keep as the same object while
// another entry changes, and its agent are the same, and for a request also its renderer and whether
// it is the oldest waiting. The renderer and the oldest waiting reach only requests, so a renderer
// made afresh by whoever renders the page, or a request answered, renders no other entry again; a
// change of language reaches every entry all the same, through its translation.
function rendersAsBefore(before: ItemProps, after: ItemProps): boolean {
  if (before.item !== after.item || before.agent !== after.agent || before.from !== after.from)
    return false;
  if (after.item.type !== 'approval' && after.item.type !== 'question') return true;
  return (
    before.renderRequest === after.renderRequest &&
    (before.oldestWaiting === after.item.request.id) ===
      (after.oldestWaiting === after.item.request.id)
  );
}

const Item = memo(function Item({ item, agent, from, oldestWaiting, renderRequest }: ItemProps) {
  const { t } = useTranslation();
  switch (item.type) {
    case 'message':
      return (
        <Message
          role={item.role}
          text={item.text}
          images={item.images}
          agent={agent}
          {...(from === undefined ? {} : { from })}
        />
      );
    case 'tool':
      return (
        <>
          <ToolEntry item={item} />
          <ToolExtra id={item.id} />
        </>
      );
    case 'file-change':
      return <FileChangeEntry change={item.change} />;
    case 'approval':
    case 'question':
      return renderRequest?.(item, { oldestWaiting: item.request.id === oldestWaiting }) ?? null;
    case 'inbox':
      return <InboxNotices notices={item.notices} />;
    case 'error':
      return (
        <p className="my-3 whitespace-pre-wrap text-del">
          {item.message ?? t('sessions.page.failed')}
        </p>
      );
  }
}, rendersAsBefore);

// The new messages from other sessions the agent was told of (ADR-0036), as the app's and never as
// the user's: each as a line with an inbox icon, its sender in the ink and its summary, in faint
// type.
function InboxNotices({ notices }: { notices: readonly InboxNotice[] }) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('sessions.inbox.notices')} className="my-3 flex flex-col gap-1 text-faint">
      {notices.map((notice) => (
        <li key={notice.id} className="flex items-start gap-2">
          <Inbox className="mt-1 size-3.5 shrink-0" />
          <span className="min-w-0 wrap-anywhere">
            {t('sessions.inbox.from')} <span className="text-ink">{notice.fromTitle}</span>:{' '}
            {notice.summary}
          </span>
        </li>
      ))}
    </ul>
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
    case 'inbox':
      return `inbox:${item.notices[0]?.id ?? String(index)}`;
    case 'error':
      return `error:${String(index)}`;
  }
}
