import ElectronStore from 'electron-store';
import { z } from 'zod';

const storedWorkspaces = z.object({
  workspaces: z.array(z.object({ id: z.string(), path: z.string(), trusted: z.boolean() })),
  selectedId: z.string().nullable(),
});

// The workspaces as the app's data keeps them; each one's name comes from its path.
export type StoredWorkspaces = z.infer<typeof storedWorkspaces>;

export interface WorkspaceStorage {
  load(): StoredWorkspaces;
  save(workspaces: StoredWorkspaces): void;
}

// workspaces.json in the folder, the app's data folder (ADR-0004), readable by the user alone. A file
// that is not JSON is cleared, and one that holds something else counts as no workspaces until the
// next change replaces it.
export function fileStorage(folder: string): WorkspaceStorage {
  const store = new ElectronStore<Record<string, unknown>>({
    cwd: folder,
    name: 'workspaces',
    configFileMode: 0o600,
    clearInvalidConfig: true,
  });
  return {
    load() {
      const stored = storedWorkspaces.safeParse(store.store);
      return stored.success ? stored.data : { workspaces: [], selectedId: null };
    },
    save(workspaces) {
      store.store = workspaces;
    },
  };
}
