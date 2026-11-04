import ElectronStore from 'electron-store';
import { z } from 'zod';
import type { ProviderId } from '../shared/events';
import type { SessionSettings } from '../shared/sessions';

// How many sessions that are not archived are kept: those active last. Archived sessions are kept
// however many there are.
const KEPT_SESSIONS = 1_000;

// What the app keeps of a session it started, so that later runs list it, show its history and resume
// it as it was: the settings it last had, which it resumes with, its permission mode among them.
export interface SessionRecord extends SessionSettings {
  // The app's id for the session, the same in every run.
  id: string;
  provider: ProviderId;
  // The provider's id for the session, which reads its history and resumes it.
  sessionId: string;
  // The folder the session works in.
  cwd: string;
  // The title the list last showed: the provider's, or else the session's first message.
  title?: string;
  // When the user last sent the session a message or a turn of it ended, in milliseconds since the
  // epoch.
  activeAt: number;
  // The session is in the archived list instead of the Sessions list.
  archived?: true;
  // How much of the model's context window the conversation took when the provider last said, which a
  // later run shows until the session runs again.
  context?: { used: number; size: number | null };
}

// A context that is not of this shape is left out, rather than the session with it.
const storedContext = z
  .object({ used: z.number().nonnegative(), size: z.number().positive().nullable() })
  .optional()
  .catch(undefined);

const storedRecord = z.object({
  id: z.string().min(1),
  provider: z.enum(['claude-code', 'codex', 'grok-build']),
  sessionId: z.string().min(1),
  cwd: z.string().startsWith('/'),
  title: z.string().optional(),
  activeAt: z.number(),
  archived: z.literal(true).optional(),
  context: storedContext,
  mode: z.enum(['auto', 'yolo']),
  gateway: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  sandbox: z.enum(['read-only', 'workspace-write', 'full-access']),
});

export interface RecordStorage {
  load(): SessionRecord[];
  save(records: SessionRecord[]): void;
}

// sessions.json in the folder, the app's data folder (ADR-0004), readable by the user alone. A file
// that is not JSON is cleared, and an entry of another shape is left out.
export function recordStorage(folder: string): RecordStorage {
  const store = new ElectronStore<Record<string, unknown>>({
    cwd: folder,
    name: 'sessions',
    configFileMode: 0o600,
    clearInvalidConfig: true,
  });
  return {
    load() {
      const entries = Array.isArray(store.store.sessions)
        ? (store.store.sessions as unknown[])
        : [];
      return entries.flatMap((entry): SessionRecord[] => {
        const parsed = storedRecord.safeParse(entry);
        if (!parsed.success) return [];
        const { title, archived, context, ...record } = parsed.data;
        return [
          {
            ...record,
            ...(title === undefined ? {} : { title }),
            ...(archived === undefined ? {} : { archived }),
            ...(context === undefined ? {} : { context }),
          },
        ];
      });
    },
    save(records) {
      store.store = { sessions: records };
    },
  };
}

// The sessions the app started, kept in its data so that later runs list them, show their history and
// resume them: every archived one, and of the others the 1,000 active last. Sessions started in a
// provider's own tools are never among them.
export class SessionRecords {
  private readonly records: Map<string, SessionRecord>;

  constructor(private readonly storage: RecordStorage) {
    this.records = new Map(storage.load().map((record) => [record.id, record]));
  }

  all(): SessionRecord[] {
    return [...this.records.values()];
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  // Keeps the session, or what it has become, and saves. Beyond 1,000 sessions that are not archived,
  // those of them active least recently go; archived sessions stay.
  keep(record: SessionRecord): void {
    this.records.set(record.id, record);
    const listed = [...this.records.values()].filter((kept) => kept.archived !== true);
    const excess = listed.length - KEPT_SESSIONS;
    if (excess > 0) {
      const oldest = listed
        .filter((kept) => kept.id !== record.id)
        .sort((left, right) => left.activeAt - right.activeAt)
        .slice(0, excess);
      for (const { id } of oldest) this.records.delete(id);
    }
    this.save();
  }

  // Forgets the session, and saves.
  remove(id: string): void {
    if (this.records.delete(id)) this.save();
  }

  private save(): void {
    this.storage.save([...this.records.values()]);
  }
}
