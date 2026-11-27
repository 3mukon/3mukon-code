import { z } from 'zod';
import type {
  ChildModels,
  CoordinatedSession,
  InboxEntry,
  SessionCoordinator,
} from '../../sessions/main/provider';
import type { ModelOption, ProviderId } from '../../sessions/shared/events';
import { CHILD_LIMIT, MESSAGE_LIMITS, senderWords } from '../../sessions/shared/inbox';

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

// Each provider a child can run on, by the same two facts: who makes the models it runs, and their
// family. An agent asked to have a model do some work needs the provider behind the model, which a
// provider's id does not always say; agents name providers by their ids, and the providers' names are
// the i18n catalogs'. Every provider needs an entry, or this does not compile.
const PROVIDERS: Record<ProviderId, { maker: string; family: string }> = {
  'claude-code': { maker: 'Anthropic', family: 'Claude' },
  'codex-cli': { maker: 'OpenAI', family: 'GPT' },
  'grok-build': { maker: 'xAI', family: 'Grok' },
  antigravity: { maker: 'Google', family: 'Gemini' },
};

// The providers as the provider argument describes them, every one in the same words.
const PROVIDER_LINES = Object.entries(PROVIDERS)
  .map(([id, { maker, family }]) => `${id} runs ${maker}’s ${family} models`)
  .join('; ');

// The session tools: listing sessions and the providers' models, starting and ending child sessions,
// sending messages and reading the inbox.
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
        .enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]])
        .optional()
        .describe(
          `The child’s provider, which decides the models it can use: ${PROVIDER_LINES}. Each may also offer other makers’ models that its account or its own settings add. Yours when left out.`,
        ),
      model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'A model the child’s provider offers, by its id exactly as provider_list gives it; one the provider does not list is refused. Yours when the child has your provider, and otherwise that provider’s default, when left out.',
        ),
      effort: z
        .string()
        .min(1)
        .max(32)
        .optional()
        .describe(
          'A reasoning effort level the child’s model takes, as provider_list gives them, such as low, medium or high; one the model does not take is refused. Yours when the child has your model, and otherwise the model’s default, when left out.',
        ),
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
        .describe(
          'The child’s title in the user’s Sessions list. A provider that gives sessions titles of its own and takes none from the app, as antigravity does, replaces it with its own once it gives one.',
        ),
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
      name: 'provider_list',
      description:
        'List the providers a child session of yours can run on, each with the models it offers the child: each model’s id, which session_start takes, its name, its reasoning effort levels, and the model and level the provider uses when you choose none. Look here for the provider that offers a model you are asked to use. A provider that cannot list its models says why.',
      inputSchema: z.object({}).strict(),
      offered: (coordinator, owner) => coordinator.mayStart(owner),
      call: async (coordinator, owner) => {
        const providers = await coordinator.providers(owner);
        return { text: providers.map(providerText).join('\n\n'), structured: { providers } };
      },
    },
    {
      name: 'session_start',
      description: `Start a child session that works beside you, in your folder, on the task its first message gives it; it starts once it has taken that message. It runs in auto mode with your sandbox level or a narrower one, its approvals go to the user, and it uses your provider, model and effort unless you choose others. A child can run on any provider, not only yours, and its provider decides which models it can use: to have a particular model do the work, choose the provider that offers it, which provider_list shows with the ids to give. It can message you with message_send, and you it. A child starts no sessions of its own, and at most ${String(CHILD_LIMIT)} of your children run at once. End a child with session_end once its work is done.`,
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
        'Read your inbox. Without a messageId, list its messages, the newest first, each with its messageId, sender, summary, time and whether you read it. With a messageId, read that message’s body, which marks it read. New messages’ summaries also reach you by themselves. The inbox also holds the app’s own reports on your child sessions: a turn of one failed, the user interrupted one, or one stopped without you or itself ending it.',
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
        const sender = senderWords(message);
        return Promise.resolve({
          text: `${sender.charAt(0).toUpperCase()}${sender.slice(1)}, ${time(message.sentAt)}\nSummary: ${message.summary}\n\n${message.body}`,
          structured: { message },
        });
      },
    },
  ];
}

// A provider as provider_list gives it in text: a line with its id and whose models it runs, then a
// line for each model it offers, or why it could not list them.
function providerText(entry: ChildModels): string {
  const { maker, family } = PROVIDERS[entry.provider];
  const head = `${entry.provider}, which runs ${maker}’s ${family} models`;
  if ('problem' in entry) return `${head}, could not list its models: ${entry.problem}`;
  if (entry.models.length === 0) return `${head}, lists no models.`;
  return [`${head}:`, ...entry.models.map(modelLine)].join('\n');
}

// A model on one line: its id, its name where that differs, whether it is the provider's default,
// and its reasoning effort levels with the default one.
function modelLine(model: ModelOption): string {
  const efforts =
    model.efforts.length === 0
      ? 'no reasoning effort levels'
      : `reasoning effort ${model.efforts.join(', ')}${model.defaultEffort === undefined ? '' : ` (${model.defaultEffort} by default)`}`;
  const name = model.label === model.id ? '' : ` (${model.label})`;
  return `- ${model.id}${name}: ${model.default === true ? 'the default; ' : ''}${efforts}`;
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

// A message of the inbox on one line: its id, its sender or the session the app reports on, when it
// came, whether it was read, and its summary.
function line(message: InboxEntry): string {
  return `${message.id}: ${senderWords(message)}, ${time(message.sentAt)}, ${message.read ? 'read' : 'unread'}: ${message.summary}`;
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
