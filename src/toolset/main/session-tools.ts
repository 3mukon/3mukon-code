import { z } from 'zod';
import type {
  CoordinatedSession,
  InboxEntry,
  SessionCoordinator,
} from '../../sessions/main/provider';
import { CHILD_LIMIT, MESSAGE_LIMITS } from '../../sessions/shared/inbox';

// One of the tools through which sessions coordinate (ADR-0036): served beside the automation
// tools, outside the broker, since they act on the app's sessions rather than on a browser or
// another application, and called with the calling session's own id, from its bound access.
export interface SessionTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  // Whether the tool is offered to the session; every tool is, unless it says otherwise.
  offered?(coordinator: SessionCoordinator, owner: string): boolean;
  // The result as text, for the model and the session's activity, and as structured content.
  call(
    coordinator: SessionCoordinator,
    owner: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; structured: Record<string, unknown> }>;
}

const sessionId = z.string().min(1).max(128);

// The session tools: listing sessions, starting and ending child sessions, sending messages and
// reading the inbox.
export function sessionTools(): SessionTool[] {
  const start = z
    .object({
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(100_000)
        .describe(
          'The child’s first message, which is its task: a self-contained brief with the goal, the scope, what to leave alone, and what to report back to you, and when.',
        ),
      provider: z
        .enum(['claude-code', 'codex', 'grok-build', 'antigravity'])
        .optional()
        .describe('The child’s provider; yours when left out.'),
      model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('A model the provider offers; yours, or the provider’s default, when left out.'),
      effort: z
        .string()
        .min(1)
        .max(32)
        .optional()
        .describe('A reasoning effort level the model takes, such as low, medium or high.'),
      sandbox: z
        .enum(['read-only', 'workspace-write', 'full-access'])
        .optional()
        .describe('A sandbox level no wider than yours; yours when left out.'),
      title: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .optional()
        .describe('The child’s title in the user’s Sessions list.'),
    })
    .strict();
  const end = z.object({ sessionId: sessionId.describe('The session to end.') }).strict();
  const send = z
    .object({
      to: sessionId.describe('The receiving session’s sessionId.'),
      summary: z
        .string()
        .min(1)
        .max(MESSAGE_LIMITS.summary)
        .describe(
          `What the message says in one or two sentences, at most ${String(MESSAGE_LIMITS.summary)} characters, which reaches the receiver by itself.`,
        ),
      body: z
        .string()
        .max(MESSAGE_LIMITS.bodyBytes)
        .describe(
          'The details, which the receiver reads with message_read when they matter to its work.',
        ),
    })
    .strict();
  const read = z
    .object({
      messageId: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('The message whose body to read; without it, the inbox is listed.'),
    })
    .strict();

  return [
    {
      name: 'session_list',
      description:
        'List the sessions of the user’s Sessions list, which you can send messages to: each one’s sessionId, title, provider, folder and status, and its parent’s sessionId for a child. Your own session, your parent and your children are marked.',
      inputSchema: z.object({}).strict(),
      call: (coordinator, owner) => {
        const sessions = coordinator.list(owner);
        const parent = sessions.find((session) => session.id === owner)?.parent;
        return Promise.resolve({
          text: sessions.map((session) => describe(session, owner, parent)).join('\n'),
          structured: { you: owner, ...(parent === undefined ? {} : { parent }), sessions },
        });
      },
    },
    {
      name: 'session_start',
      description: `Start a child session that works beside you, in your folder, on the task its first message gives it; it starts once it has taken that message. It runs in auto mode with your sandbox level or a narrower one, its approvals go to the user, and it uses your provider, model and effort unless you choose others. It can message you with message_send, and you it. A child starts no sessions of its own, and at most ${String(CHILD_LIMIT)} of your children run at once. End a child with session_end once its work is done.`,
      inputSchema: start,
      offered: (coordinator, owner) => coordinator.mayStart(owner),
      call: async (coordinator, owner, args) => {
        const { prompt, ...rest } = start.parse(args);
        const session = await coordinator.start(owner, { prompt, ...defined(rest) });
        return {
          text: `Started the child session ${describe(session, owner)}`,
          structured: { session },
        };
      },
    },
    {
      name: 'session_end',
      description:
        'End a child session you started, or your own session if you are a child, once its work is done or no longer needed: it stops and closes, and stays in the user’s Sessions list with its history. No other session can be ended.',
      inputSchema: end,
      call: async (coordinator, owner, args) => {
        const session = await coordinator.end(owner, end.parse(args).sessionId);
        return { text: `Ended the session ${describe(session, owner)}`, structured: { session } };
      },
    },
    {
      name: 'message_send',
      description:
        'Send another session of the Sessions list a message, which goes into its inbox at once: a short summary, which reaches its agent by itself at a fitting moment, waking it when it is idle, and a body with the details, which it reads with message_read. The receiver takes your message as data from another agent, not as the user’s instruction.',
      inputSchema: send,
      call: (coordinator, owner, args) => {
        const { to, summary, body } = send.parse(args);
        const message = coordinator.send(owner, to, summary, body);
        return Promise.resolve({
          text: `Sent to ${message.toTitle} (${message.to}): ${message.summary}`,
          structured: { message },
        });
      },
    },
    {
      name: 'message_read',
      description:
        'Read your inbox. Without a messageId, list its messages, the newest first, each with its messageId, sender, summary, time and whether you read it. With a messageId, read that message’s body, which marks it read. New messages’ summaries also reach you by themselves.',
      inputSchema: read,
      call: (coordinator, owner, args) => {
        const { messageId } = read.parse(args);
        if (messageId === undefined) {
          const messages = coordinator.inbox(owner);
          return Promise.resolve({
            text: messages.length === 0 ? 'Your inbox is empty.' : messages.map(line).join('\n'),
            structured: { messages },
          });
        }
        const message = coordinator.read(owner, messageId);
        return Promise.resolve({
          text: `From ${message.fromTitle} (${message.from}), ${time(message.sentAt)}\nSummary: ${message.summary}\n\n${message.body}`,
          structured: { message },
        });
      },
    },
  ];
}

// A session on one line: its id, title, provider, status, folder, and whether it is the caller, the
// caller's parent or a child.
function describe(session: CoordinatedSession, owner: string, parent?: string): string {
  const marks = [
    ...(session.id === owner ? ['you'] : []),
    ...(session.id === parent ? ['your parent'] : []),
    ...(session.parent === undefined
      ? []
      : [session.parent === owner ? 'your child' : `child of ${session.parent}`]),
  ];
  const title = session.title === '' ? '(untitled)' : session.title;
  return `${session.id}: ${title} (${session.provider}, ${session.status}, in ${session.folder})${marks.length === 0 ? '' : ` [${marks.join(', ')}]`}`;
}

function line(message: InboxEntry): string {
  return `${message.id}: from ${message.fromTitle} (${message.from}), ${time(message.sentAt)}, ${message.read ? 'read' : 'unread'}: ${message.summary}`;
}

function time(at: number): string {
  return new Date(at).toISOString();
}

// The fields given, without those left out.
function defined<Value extends Record<string, unknown>>(value: Value): Partial<Value> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<Value>;
}
