import { createContext, memo, useContext, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleAlert,
  CirclePause,
  CircleStop,
  FoldVertical,
  Inbox,
  Layers,
} from '../../ui/renderer/icons';
import { StatusDot, type Status } from '../../ui/renderer/status-dot';
import type { MessageImage, Task } from '../shared/events';
import type { InboxNotice, InboxReport } from '../shared/inbox';
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
import { Entry, FileChangeEntry, ToolCall } from './tool-call';

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
// thinking quieter; each tool call as one entry, with the files it changed and their diffs, and a run of
// them that the agent's next message follows folded into one line (foldRuns); the
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
        {foldRuns(state?.timeline.slice(from) ?? [], from).map((row) => {
          const item = ({ item: entry, index }: Placed) => (
            <Item
              key={keyOf(entry, index)}
              item={entry}
              agent={agent}
              oldestWaiting={oldestWaiting}
              {...(entry === first && firstFrom !== undefined ? { from: firstFrom } : {})}
              {...(renderRequest === undefined ? {} : { renderRequest })}
            />
          );
          return row.type === 'item' ? (
            item(row)
          ) : (
            <ToolRun key={runKey(row)} calls={row.calls} failed={row.failed}>
              {row.items.map(item)}
            </ToolRun>
          );
        })}
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

// An item of the activity with its place in the whole timeline, by which it keeps its key.
interface Placed {
  item: TimelineItem;
  index: number;
}

// What the activity shows in order: an item, or a run of tool calls folded into one line.
type Row =
  ({ type: 'item' } & Placed) | { type: 'run'; items: Placed[]; calls: number; failed: number };

// Whether an item belongs in a run of tool calls: a call, a file change no call made, or the agent's
// thinking, which would otherwise split a run into small ones.
function inRun(item: TimelineItem): boolean {
  return (
    item.type === 'tool' ||
    item.type === 'file-change' ||
    (item.type === 'message' && item.role === 'thinking')
  );
}

// The activity's rows, from its items as they stand from the index given: two or more tool calls in a
// row fold into one line once the agent replies after them in the same turn, which says the work they
// did is done. The user's message or an error ends a turn. A run with no reply after it yet shows as
// its items, so that the work shows as it happens, and so does one whose turn ended without a reply.
// The user's messages, approvals and questions, the app's notices and errors end a run, each staying
// where it stands, so that a notice between calls splits them into runs that fold apart.
export function foldRuns(items: readonly TimelineItem[], from = 0): Row[] {
  // Whether the agent replies at or after each item within its turn.
  const replied: boolean[] = [];
  let ahead = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.type === 'error' || (item.type === 'message' && item.role === 'user')) ahead = false;
    else if (item.type === 'message' && item.role === 'agent') ahead = true;
    replied[index] = ahead;
  }
  const rows: Row[] = [];
  let run: Placed[] = [];
  const end = (folds: boolean) => {
    const calls = run.filter(({ item }) => item.type === 'tool');
    if (folds && calls.length >= 2) {
      const failed = calls.filter(({ item }) => item.type === 'tool' && item.status === 'failed');
      rows.push({ type: 'run', items: run, calls: calls.length, failed: failed.length });
    } else {
      rows.push(...run.map((placed) => ({ type: 'item' as const, ...placed })));
    }
    run = [];
  };
  items.forEach((item, offset) => {
    const placed = { item, index: from + offset };
    if (inRun(item)) {
      run.push(placed);
      return;
    }
    end(replied[offset] === true);
    rows.push({ type: 'item', ...placed });
  });
  end(false);
  return rows;
}

// A run's key, by its first item, so that a run the user opened stays open as the activity grows.
function runKey(row: Extract<Row, { type: 'run' }>): string {
  const first = row.items[0];
  return first === undefined ? 'run' : `run:${keyOf(first.item, first.index)}`;
}

// A run of tool calls as one line, which says how many calls it holds and how many of them failed, in
// the colour of a failed call, and opens, as an entry does, to show them as they show unfolded.
function ToolRun({
  calls,
  failed,
  children,
}: {
  calls: number;
  failed: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Entry
      icon={Layers}
      kind={t('sessions.run.kind')}
      status="completed"
      bright={false}
      title={
        <>
          {t('sessions.run.calls', { count: calls })}
          {failed > 0 && (
            <span className="text-del">
              {' · '}
              {t('sessions.run.failed', { count: failed })}
            </span>
          )}
        </>
      }
      body={<div className="min-w-0">{children}</div>}
    />
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
    // A compaction of the conversation, quiet as the app's notices are.
    case 'compaction':
      return (
        <p className="my-3 flex items-start gap-2 text-faint">
          <FoldVertical className="mt-1 size-3.5 shrink-0" />
          <span>
            {t(item.trigger === 'auto' ? 'sessions.compaction.auto' : 'sessions.compaction.manual')}
          </span>
        </p>
      );
    case 'error':
      return (
        <p className="my-3 whitespace-pre-wrap text-del">
          {item.message ?? t('sessions.page.failed')}
        </p>
      );
  }
}, rendersAsBefore);

// A report's icon (ADR-0042), by what the app saw of the child, and its colour: a failed turn and a
// child that stopped in the colour of a failed call.
const reportIcons: Record<InboxReport, { Icon: typeof Inbox; look: string }> = {
  failed: { Icon: CircleAlert, look: 'text-del' },
  interrupted: { Icon: CirclePause, look: '' },
  stopped: { Icon: CircleStop, look: 'text-del' },
};

// The new messages from other sessions the agent was told of (ADR-0036), as the app's and never as
// the user's: each as a line with an inbox icon, its sender in the ink and its summary, in faint
// type; a report of the app's own on a child (ADR-0042) names the child as what it reports on, with
// an icon of what it reports.
function InboxNotices({ notices }: { notices: readonly InboxNotice[] }) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('sessions.inbox.notices')} className="my-3 flex flex-col gap-1 text-faint">
      {notices.map((notice) => {
        const { Icon, look } =
          notice.report === undefined ? { Icon: Inbox, look: '' } : reportIcons[notice.report];
        return (
          <li key={notice.id} className="flex items-start gap-2">
            <Icon className={`mt-1 size-3.5 shrink-0 ${look}`} />
            <span className="min-w-0 wrap-anywhere">
              {t(notice.report === undefined ? 'sessions.inbox.from' : 'sessions.inbox.report')}{' '}
              <span className="text-ink">{notice.fromTitle}</span>: {notice.summary}
            </span>
          </li>
        );
      })}
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
    case 'compaction':
      return `compaction:${item.id}`;
    case 'error':
      return `error:${String(index)}`;
  }
}
