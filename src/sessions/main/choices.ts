import ElectronStore from 'electron-store';
import { z } from 'zod';
import type { ProviderId } from '../shared/events';
import { isDayFolder } from '../shared/folders';
import type { FolderChoices, RememberedChoice } from '../shared/sessions';

// How many folders' settings are kept: those of the folders last used.
const KEPT_FOLDERS = 200;

const storedChoice = z.object({
  provider: z.enum(['claude-code', 'codex', 'grok-build', 'antigravity']),
  gateway: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  sandbox: z.enum(['read-only', 'workspace-write', 'full-access']),
});
const storedFolder = storedChoice.extend({ folder: z.string() });

export interface StoredChoices {
  // Each folder's settings, the folder last used last.
  folders: [string, RememberedChoice][];
  dayFolders?: RememberedChoice;
}

export interface ChoiceStorage {
  load(): StoredChoices;
  save(choices: StoredChoices): void;
}

// session-choices.json in the folder, the app's data folder (ADR-0039), readable by the user alone. A
// file that is not JSON is cleared, and an entry of another shape is left out.
export function choiceStorage(folder: string): ChoiceStorage {
  const store = new ElectronStore<Record<string, unknown>>({
    cwd: folder,
    name: 'session-choices',
    configFileMode: 0o600,
    clearInvalidConfig: true,
  });
  return {
    load() {
      const entries = Array.isArray(store.store.folders) ? (store.store.folders as unknown[]) : [];
      const folders = entries.flatMap((entry): [string, RememberedChoice][] => {
        const parsed = storedFolder.safeParse(entry);
        if (!parsed.success) return [];
        const { folder: path, ...choice } = parsed.data;
        return [[path, choice]];
      });
      const days = storedChoice.safeParse(store.store.dayFolders);
      return { folders, ...(days.success ? { dayFolders: days.data } : {}) };
    },
    save({ folders, dayFolders }) {
      store.store = {
        folders: folders.map(([path, choice]) => ({ folder: path, ...choice })),
        ...(dayFolders === undefined ? {} : { dayFolders }),
      };
    },
  };
}

// The settings sessions last used, so that a session page opened in the same folder again starts with
// them, kept in the app's data: each folder's, for the folders last used, and one set for all the day
// folders in the day root.
export class RememberedChoices {
  private readonly folders: Map<string, RememberedChoice>;
  private dayFolders: RememberedChoice | undefined;

  constructor(
    private readonly storage: ChoiceStorage,
    private readonly dayRoot: string,
  ) {
    const stored = storage.load();
    this.folders = new Map(stored.folders);
    this.dayFolders = stored.dayFolders;
  }

  // Leaving out the providers the app does not offer.
  all(providers: readonly ProviderId[]): FolderChoices {
    const offered = (choice: RememberedChoice) => providers.includes(choice.provider);
    return {
      folders: Object.fromEntries([...this.folders].filter(([, choice]) => offered(choice))),
      dayRoot: this.dayRoot,
      ...(this.dayFolders !== undefined && offered(this.dayFolders)
        ? { dayFolders: this.dayFolders }
        : {}),
    };
  }

  remember(folder: string, choice: RememberedChoice): void {
    if (isDayFolder(this.dayRoot, folder)) {
      this.dayFolders = choice;
    } else {
      this.folders.delete(folder);
      this.folders.set(folder, choice);
      for (const oldest of this.folders.keys()) {
        if (this.folders.size <= KEPT_FOLDERS) break;
        this.folders.delete(oldest);
      }
    }
    this.storage.save({
      folders: [...this.folders],
      ...(this.dayFolders === undefined ? {} : { dayFolders: this.dayFolders }),
    });
  }
}
