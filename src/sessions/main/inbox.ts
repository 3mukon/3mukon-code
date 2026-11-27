import { randomUUID } from 'node:crypto';
import ElectronStore from 'electron-store';
import { z } from 'zod';
import { MESSAGE_LIMITS, type InboxNotice } from '../shared/inbox';

// A message one session sent another (ADR-0036), as the receiving session's inbox keeps it: its
// sender, as the app's id and the title the sender had, its summary and body, when it was sent, and
// once they happen, when the receiving agent was told of it and when it read the body.
export interface InboxMessage extends InboxNotice {
  to: string;
  body: string;
  toldAt?: number;
  readAt?: number;
}

const storedMessage = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  fromTitle: z.string(),
  to: z.string().min(1),
  summary: z.string(),
  body: z.string(),
  sentAt: z.number(),
  toldAt: z.number().optional(),
  readAt: z.number().optional(),
  report: z.enum(['failed', 'interrupted', 'stopped']).optional(),
});

export interface InboxStorage {
  load(): InboxMessage[];
  save(messages: InboxMessage[]): void;
}

// session-inbox.json in the folder, the app's data folder (ADR-0039), readable by the user alone. A
// file that is not JSON is cleared, and an entry of another shape is left out.
export function inboxStorage(folder: string): InboxStorage {
  const store = new ElectronStore<Record<string, unknown>>({
    cwd: folder,
    name: 'session-inbox',
    configFileMode: 0o600,
    clearInvalidConfig: true,
  });
  return {
    load() {
      const entries = Array.isArray(store.store.messages)
        ? (store.store.messages as unknown[])
        : [];
      return entries.flatMap((entry): InboxMessage[] => {
        const parsed = storedMessage.safeParse(entry);
        if (!parsed.success) return [];
        const { toldAt, readAt, report, ...message } = parsed.data;
        return [
          {
            ...message,
            ...(toldAt === undefined ? {} : { toldAt }),
            ...(readAt === undefined ? {} : { readAt }),
            ...(report === undefined ? {} : { report }),
          },
        ];
      });
    },
    save(messages) {
      store.store = { messages };
    },
  };
}

// The messages in memory, for tests.
export function memoryInboxStorage(initial: InboxMessage[] = []): InboxStorage & {
  saved: InboxMessage[][];
} {
  const saved: InboxMessage[][] = [];
  return {
    saved,
    load: () => initial.map((message) => ({ ...message })),
    save: (messages) => saved.push(messages.map((message) => ({ ...message }))),
  };
}

// Every session's inbox, saved as it changes, so that messages, whether each was told and read,
// outlast the app's run. Each inbox keeps its newest 500 messages, those read leaving first.
export class SessionInboxes {
  private readonly messages: InboxMessage[];

  constructor(private readonly storage: InboxStorage) {
    this.messages = storage.load();
  }

  // Puts a message in the receiving session's inbox and gives it back.
  send(message: Omit<InboxMessage, 'id' | 'toldAt' | 'readAt'>): InboxMessage {
    const kept: InboxMessage = { ...message, id: randomUUID() };
    this.messages.push(kept);
    this.trim(message.to);
    this.save();
    return kept;
  }

  // A session's messages, the newest first.
  list(to: string): InboxMessage[] {
    return this.messages.filter((message) => message.to === to).sort(newestFirst);
  }

  // A session's message, or undefined where it has none of the id.
  get(to: string, id: string): InboxMessage | undefined {
    return this.messages.find((message) => message.to === to && message.id === id);
  }

  // The messages the session's agent has not been told of, the oldest first, as many as a notice
  // names.
  untold(to: string): InboxMessage[] {
    return this.messages
      .filter((message) => message.to === to && message.toldAt === undefined)
      .sort((left, right) => left.sentAt - right.sentAt)
      .slice(0, MESSAGE_LIMITS.notice);
  }

  // Marks messages told, now.
  told(to: string, ids: readonly string[]): void {
    const now = Date.now();
    let changed = false;
    for (const message of this.messages) {
      if (message.to === to && message.toldAt === undefined && ids.includes(message.id)) {
        message.toldAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // Marks a message read, now, and told, as reading it tells the agent of it.
  read(to: string, id: string): InboxMessage | undefined {
    const message = this.get(to, id);
    if (message === undefined) return undefined;
    if (message.readAt === undefined || message.toldAt === undefined) {
      const now = Date.now();
      message.readAt ??= now;
      message.toldAt ??= now;
      this.save();
    }
    return message;
  }

  // Forgets the messages a session received, as it leaves the app's lists; those it sent stay with
  // their receivers, under the title it had.
  forget(session: string): void {
    const before = this.messages.length;
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.to === session) this.messages.splice(index, 1);
    }
    if (this.messages.length !== before) this.save();
  }

  private trim(to: string): void {
    const own = this.messages.filter((message) => message.to === to);
    if (own.length <= MESSAGE_LIMITS.inbox) return;
    const leaving = new Set(
      [...own]
        .sort((left, right) =>
          (left.readAt === undefined) === (right.readAt === undefined)
            ? left.sentAt - right.sentAt
            : left.readAt === undefined
              ? 1
              : -1,
        )
        .slice(0, own.length - MESSAGE_LIMITS.inbox),
    );
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message !== undefined && leaving.has(message)) this.messages.splice(index, 1);
    }
  }

  private save(): void {
    this.storage.save(this.messages.map((message) => ({ ...message })));
  }
}

function newestFirst(left: InboxMessage, right: InboxMessage): number {
  return right.sentAt - left.sentAt;
}
