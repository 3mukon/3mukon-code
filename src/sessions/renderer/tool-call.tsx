import { Fragment, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brain,
  ChevronRight,
  CircleStop,
  Cpu,
  FileText,
  FolderInput,
  GitBranchPlus,
  Globe,
  Inbox,
  LayoutPanelLeft,
  ListChecks,
  ListTree,
  MailOpen,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
  Pencil,
  Plug,
  Pointer,
  RefreshCw,
  Search,
  Send,
  Terminal,
  ToggleRight,
  Trash,
  Wrench,
} from '../../ui/renderer/icons';
import { Tag } from '../../ui/renderer/tag';
import type { FileChange, ToolKind, ToolStatus } from '../shared/events';
import type { ToolItem } from '../shared/session-state';
import { toolWords, type McpCall } from '../shared/tools';
import { DiffView, linesChanged } from './diff-view';
import { Images } from './images';
import { withoutInboxText } from '../shared/inbox';

const kindIcons: Record<ToolKind, typeof Pencil> = {
  read: FileText,
  edit: Pencil,
  delete: Trash,
  move: FolderInput,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ToggleRight,
  other: Wrench,
};

// The icon of each of the app's own tools beside the browser's and the computer's, by what the tool
// does, since all their kinds are other; an action of a tool has one of its own where it differs, such
// as reading the inbox rather than a message.
const appIcons: Partial<Record<string, typeof Pencil>> = {
  session_list: ListTree,
  provider_list: Cpu,
  session_start: GitBranchPlus,
  session_end: CircleStop,
  message_send: Send,
  message_read: MailOpen,
  message_read_inbox: Inbox,
  panel_list: PanelsTopLeft,
  panel_present: PanelRightOpen,
  panel_update: RefreshCw,
  panel_arrange: LayoutPanelLeft,
  panel_close: PanelRightClose,
  automation_capabilities: ListChecks,
};

// The icon a call shows: for the app's browser and computer tools their family's, or a pointer for a
// click; for the app's other tools their own; for another server's tool a plug; else its kind's.
function iconOf(item: ToolItem, family: 'browser' | 'computer' | undefined): typeof Pencil {
  const call = item.mcp;
  if (family !== undefined) {
    if (call?.clicks === true) return Pointer;
    return family === 'browser' ? Globe : Monitor;
  }
  if (call?.app === true) {
    return appIcons[call.action ?? call.tool] ?? appIcons[call.tool] ?? kindIcons[item.kind];
  }
  return call === undefined ? kindIcons[item.kind] : Plug;
}

// The icon's colour tells how far a call has gone.
const iconLooks: Record<ToolStatus, string> = {
  pending: 'text-wait',
  running: 'text-run',
  completed: 'text-faint',
  failed: 'text-del',
};

const changeKinds: Record<FileChange['kind'], ToolKind> = {
  add: 'edit',
  update: 'edit',
  delete: 'delete',
  move: 'move',
};

// One tool call as one entry, from its start to its end: a line with an icon of its kind in the colour
// of its state, what it works on, the lines its changes add and remove, and Failed if it failed. Opened,
// the entry shows the diff of each file the call changed, or else the images the call returned, and
// its command and its output. A call that changed one file names it once, in the line; one that changed
// several names each file above its diff.
export function ToolCall({ item }: { item: ToolItem }) {
  const { t } = useTranslation();
  const family = appFamily(item.mcp);
  const kind =
    family === undefined
      ? t(`sessions.tool.kind.${item.kind}`)
      : t(`sessions.automation.kind.${family}`);
  const only = item.changes.length === 1 ? item.changes[0] : undefined;
  let title: ReactNode = item.title === '' ? (item.command ?? kind) : item.title;
  if (item.mcp !== undefined) title = <McpTitle call={item.mcp} />;
  if (only !== undefined) title = changedPath(only);
  const command = item.command === title ? undefined : item.command;
  let body: ReactNode;
  if (item.changes.length > 0) {
    body = item.changes.map((change) => (
      <Changed key={change.id} change={change} named={only === undefined} />
    ));
  } else if (command !== undefined || item.output !== '' || item.images !== undefined) {
    body = (
      <>
        {item.images !== undefined && <Images images={item.images} />}
        {(command !== undefined || item.output !== '') && (
          <Output
            command={command}
            output={item.mcp?.app === true ? withoutInboxText(item.output) : item.output}
          />
        )}
      </>
    );
  }
  const icon = iconOf(item, family);
  return (
    <Entry
      icon={icon}
      kind={kind}
      status={item.status}
      title={title}
      bright={item.status === 'running' || item.changes.length > 0}
      {...(item.changes.length === 0 ? {} : { counts: countAll(item.changes) })}
      body={body}
    />
  );
}

// Which of the app's own browser and computer tools a call is, if it is one: until the app's record of
// the call takes the provider's entry's place, the entry is marked and named for VoiceOver as that
// record will be, a page with a globe, an application with a screen and a click with a pointer,
// rather than as any other tool.
function appFamily(call: McpCall | undefined): 'browser' | 'computer' | undefined {
  if (call?.app !== true) return undefined;
  if (call.tool.startsWith('browser_')) return 'browser';
  if (call.tool.startsWith('computer_')) return 'computer';
  return undefined;
}

// Where a label's subject goes, which no translation holds.
const SUBJECT = '\u0001';

// A call of an MCP tool by what it did, rather than by the name its provider gives it: one of the
// app's own tools in the app's words, with what it acted on in its place in them, apart in small
// type, such as Sent a message: Tests pass; another server's tool by the server and the tool's name
// in words, such as github · create issue.
function McpTitle({ call }: { call: McpCall }) {
  const { t, i18n } = useTranslation();
  if (call.app !== true) {
    return <>{t('sessions.tool.mcp', { server: call.server, tool: toolWords(call.tool) })}</>;
  }
  const key = `sessions.tool.app.${call.action ?? call.tool}`;
  const about = `${key}_subject`;
  if (call.subject === undefined || !i18n.exists(about)) {
    return <>{t(key, { defaultValue: toolWords(call.tool) })}</>;
  }
  const parts = t(about, { subject: SUBJECT, defaultValue: SUBJECT }).split(SUBJECT);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="text-[12px]">{call.subject}</span>}
          {part}
        </Fragment>
      ))}
    </>
  );
}

// A file change that no tool call in the timeline made, as an entry of its own.
export function FileChangeEntry({ change }: { change: FileChange }) {
  const { t } = useTranslation();
  const kind = changeKinds[change.kind];
  return (
    <Entry
      icon={kindIcons[kind]}
      kind={t(`sessions.tool.kind.${kind}`)}
      status="completed"
      title={changedPath(change)}
      bright
      counts={linesChanged(change.diff)}
      body={<DiffView diff={change.diff} />}
    />
  );
}

interface EntryProps {
  icon: typeof Pencil;
  // The kind in words, and the state, which VoiceOver reads with the title.
  kind: string;
  status: ToolStatus;
  // Where what came of the entry wants the user's eye more than its state does, as a call refused or
  // stopped part-way: its icon in the wait colour, its title as any other's, and its note.
  attention?: boolean;
  // The title, in words, or in words some of which are drawn apart, such as a page's address.
  title: ReactNode;
  // The title in the ink colour, as for a call still running and for files changed.
  bright: boolean;
  counts?: { added: number; removed: number };
  // Short facts after the title, each in a dashed tag, such as how a page is shared.
  tags?: readonly string[];
  // What came of it, in words after the title, in place of the state.
  note?: string;
  // What the entry shows opened; without it, the entry does not open.
  body?: ReactNode;
}

// An entry's line, which opens and closes the entry from the pointer and the keyboard, with a chevron
// at its end shown while the entry is open or the pointer or the focus is on it. Tool calls and file
// changes are entries, and so are the approvals module's answered requests.
export function Entry({
  icon: Icon,
  kind,
  status,
  attention = false,
  title,
  bright,
  counts,
  tags,
  note,
  body,
}: EntryProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const failed = status === 'failed' && !attention;
  const sign = (
    <Icon className={`size-3.5 shrink-0 ${attention ? 'text-wait' : iconLooks[status]}`} />
  );
  const line = (
    <>
      <span className="sr-only">{t('sessions.tool.named', { kind })}</span>
      <span className={`min-w-0 truncate ${failed ? 'text-del' : bright ? 'text-ink' : ''}`}>
        {title}
      </span>
      {counts !== undefined && <Counts {...counts} />}
      {tags?.map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
      {note !== undefined ? (
        <span className="max-w-full shrink-0 truncate text-faint">{note}</span>
      ) : failed ? (
        <span className="shrink-0 text-del">{t('sessions.tool.status.failed')}</span>
      ) : (
        <span className="sr-only">{t(`sessions.tool.status.${status}`)}</span>
      )}
    </>
  );
  if (body === undefined) {
    // Its note goes under its words where the line has no room for both.
    return (
      <p className="my-0.5 flex min-w-0 items-baseline gap-2">
        <span className="flex h-lh shrink-0 items-center self-start">{sign}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">{line}</span>
      </p>
    );
  }
  return (
    <div className="my-0.5 min-w-0">
      <button
        type="button"
        aria-expanded={open}
        {...(open ? { 'aria-controls': bodyId } : {})}
        onClick={() => {
          setOpen(!open);
        }}
        className="group flex w-full min-w-0 items-center gap-2 rounded-sm text-left hover:text-ink"
      >
        {sign}
        {line}
        <ChevronRight
          className={`size-3 shrink-0 text-faint transition-transform motion-reduce:transition-none ${
            open ? 'rotate-90' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          }`}
        />
      </button>
      {open && (
        <div id={bodyId} className="mt-1 mb-2 flex min-w-0 flex-col gap-2 pl-5.5">
          {body}
        </div>
      )}
    </div>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex shrink-0 gap-1.5">
      <span className="text-add">+{added}</span>
      <span className="text-del">−{removed}</span>
    </span>
  );
}

// One file a call changed: its diff, after its path and counts where the entry's line names no file.
function Changed({ change, named }: { change: FileChange; named: boolean }) {
  return (
    <div className="min-w-0">
      {named && (
        <p className="mb-0.5 flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-ink">{changedPath(change)}</span>
          <Counts {...linesChanged(change.diff)} />
        </p>
      )}
      <DiffView diff={change.diff} />
    </div>
  );
}

// What a call ran and what it printed, in a well: the command after a prompt, and the output below.
export function Output({ command, output }: { command: string | undefined; output: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-dashed border-line paper-well px-2.5 py-1.5 text-[11.5px]/[1.6] whitespace-pre-wrap wrap-anywhere [tab-size:4]">
      {command !== undefined && (
        <span className="text-ink">
          <span className="text-faint select-none">$ </span>
          {command}
          {output === '' ? '' : '\n'}
        </span>
      )}
      {output}
    </pre>
  );
}

function changedPath(change: FileChange): string {
  return change.newPath === undefined ? change.path : `${change.path} → ${change.newPath}`;
}

function countAll(changes: FileChange[]): { added: number; removed: number } {
  return changes.reduce(
    (sum, change) => {
      const { added, removed } = linesChanged(change.diff);
      return { added: sum.added + added, removed: sum.removed + removed };
    },
    { added: 0, removed: 0 },
  );
}
