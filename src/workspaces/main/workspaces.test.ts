import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceList } from '../shared/workspaces';
import { fileStorage, type StoredWorkspaces, type WorkspaceStorage } from './storage';
import { Workspaces, type WorkspaceActions, type WorkspacesUi } from './workspaces';

let root: string;
let web: string;
let api: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'workspaces-')));
  web = join(root, 'web');
  api = join(root, 'api');
  mkdirSync(web);
  mkdirSync(api);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function memoryStorage(initial: StoredWorkspaces = { workspaces: [], selectedId: null }) {
  const storage: WorkspaceStorage & { saved: StoredWorkspaces } = {
    saved: initial,
    load: () => storage.saved,
    save(workspaces) {
      storage.saved = workspaces;
    },
  };
  return storage;
}

// Answers for the user: the folder the picker returns, and the trust answer for each folder by name.
function answers({ pick, trust = {} }: { pick?: string; trust?: Record<string, boolean> } = {}) {
  const asked: string[] = [];
  let menu: WorkspaceActions | undefined;
  let folderMenus = 0;
  const ui: WorkspacesUi = {
    pickFolder: () => Promise.resolve(pick),
    askTrust: (name) => {
      asked.push(name);
      return Promise.resolve(trust[name] ?? true);
    },
    showMenu: (_workspace, actions) => {
      menu = actions;
      return Promise.resolve(null);
    },
    showFolderMenu: () => {
      folderMenus += 1;
      return Promise.resolve('open-in-terminal');
    },
  };
  return { ui, asked, menu: () => menu, folderMenus: () => folderMenus };
}

const names = (list: WorkspaceList) => list.workspaces.map((workspace) => workspace.name);
const selected = (list: WorkspaceList) =>
  list.workspaces.find((workspace) => workspace.id === list.selectedId)?.name;

describe('Workspaces', () => {
  it('adds the folder the user picks, with the trust answer, and selects it', async () => {
    const workspaces = new Workspaces(memoryStorage());
    const changes: WorkspaceList[] = [];
    workspaces.onChange((list) => changes.push(list));
    const user = answers({ pick: web, trust: { web: false } });
    await workspaces.add(user.ui);
    expect(user.asked).toEqual(['web']);
    const list = workspaces.list();
    expect(list.workspaces).toEqual([
      { id: list.selectedId, name: 'web', path: web, trusted: false },
    ]);
    expect(changes).toEqual([list]);
  });

  it('adds nothing when the user cancels the folder picker', async () => {
    const workspaces = new Workspaces(memoryStorage());
    const user = answers();
    await workspaces.add(user.ui);
    expect(user.asked).toEqual([]);
    expect(workspaces.list()).toEqual({ workspaces: [], selectedId: null });
  });

  it('adds dropped folders one after another and skips files and items without paths', async () => {
    const workspaces = new Workspaces(memoryStorage());
    writeFileSync(join(root, 'notes.txt'), '');
    const user = answers({ trust: { api: false } });
    await workspaces.addFolders(
      ['', 'relative/web', join(root, 'notes.txt'), join(root, 'gone'), web, api],
      user.ui,
    );
    expect(user.asked).toEqual(['web', 'api']);
    const list = workspaces.list();
    expect(list.workspaces.map(({ name, trusted }) => ({ name, trusted }))).toEqual([
      { name: 'web', trusted: true },
      { name: 'api', trusted: false },
    ]);
    expect(selected(list)).toBe('api');
  });

  it('selects a folder already on the list instead of adding it again, also through a link', async () => {
    const workspaces = new Workspaces(memoryStorage());
    await workspaces.addFolders([web, api], answers().ui);
    symlinkSync(web, join(root, 'web-link'));
    const user = answers({ pick: join(root, 'web-link') });
    await workspaces.add(user.ui);
    expect(user.asked).toEqual([]);
    expect(names(workspaces.list())).toEqual(['web', 'api']);
    expect(selected(workspaces.list())).toBe('web');
  });

  it('asks about one folder at a time, even when additions overlap', async () => {
    const workspaces = new Workspaces(memoryStorage());
    let asking = 0;
    let overlapped = false;
    const ui: WorkspacesUi = {
      pickFolder: () => Promise.resolve(api),
      askTrust: async () => {
        asking += 1;
        overlapped ||= asking > 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        asking -= 1;
        return true;
      },
      showMenu: vi.fn(),
      showFolderMenu: vi.fn(),
    };
    await Promise.all([workspaces.addFolders([web], ui), workspaces.add(ui)]);
    expect(overlapped).toBe(false);
    expect(names(workspaces.list())).toEqual(['web', 'api']);
  });

  it('shows one folder picker for additions asked for before it closes, and another one after', async () => {
    const workspaces = new Workspaces(memoryStorage());
    const pickFolder = vi.fn(() => Promise.resolve(undefined));
    const ui: WorkspacesUi = { ...answers().ui, pickFolder };
    await Promise.all([workspaces.add(ui), workspaces.add(ui)]);
    expect(pickFolder).toHaveBeenCalledOnce();
    await workspaces.add(ui);
    expect(pickFolder).toHaveBeenCalledTimes(2);
  });

  it('keeps one selected, and selects the next one when the selected one is removed', async () => {
    const third = join(root, 'docs');
    mkdirSync(third);
    const workspaces = new Workspaces(memoryStorage());
    await workspaces.addFolders([web, api, third], answers().ui);
    const [first, second, last] = workspaces.list().workspaces.map((workspace) => workspace.id);
    if (first === undefined || second === undefined || last === undefined)
      throw new Error('missing');
    workspaces.select(second);
    expect(selected(workspaces.list())).toBe('api');
    workspaces.select('unknown');
    expect(selected(workspaces.list())).toBe('api');
    workspaces.remove(second);
    expect(names(workspaces.list())).toEqual(['web', 'docs']);
    expect(selected(workspaces.list())).toBe('docs');
    workspaces.remove(last);
    expect(selected(workspaces.list())).toBe('web');
    workspaces.remove(first);
    expect(workspaces.list()).toEqual({ workspaces: [], selectedId: null });
  });

  it('changes a workspace’s trust answer, and leaves its folder alone when removing it', async () => {
    const storage = memoryStorage();
    const workspaces = new Workspaces(storage);
    await workspaces.addFolders([web], answers().ui);
    const id = workspaces.list().selectedId ?? '';
    const changes: WorkspaceList[] = [];
    workspaces.onChange((list) => changes.push(list));
    workspaces.setTrusted(id, false);
    workspaces.setTrusted(id, false);
    expect(storage.saved.workspaces[0]?.trusted).toBe(false);
    expect(changes).toHaveLength(1);
    workspaces.remove(id);
    expect(storage.saved).toEqual({ workspaces: [], selectedId: null });
    expect(realpathSync(web)).toBe(web);
  });

  it('shows a workspace’s menu, whose items change its trust answer or remove it', async () => {
    const workspaces = new Workspaces(memoryStorage());
    await workspaces.addFolders([web, api], answers().ui);
    const [id] = workspaces.list().workspaces.map((workspace) => workspace.id);
    const user = answers();
    await workspaces.showMenu(id ?? '', '', user.ui);
    user.menu()?.setTrusted(false);
    expect(workspaces.list().workspaces[0]?.trusted).toBe(false);
    user.menu()?.remove();
    expect(names(workspaces.list())).toEqual(['api']);
    const nobody = answers();
    expect(await workspaces.showMenu('unknown', '', nobody.ui)).toBeNull();
    expect(nobody.menu()).toBeUndefined();
  });

  it('shows a folder’s menu for a folder inside a workspace, leaving Open in Terminal to the window', async () => {
    const workspaces = new Workspaces(memoryStorage());
    await workspaces.addFolders([web], answers().ui);
    const [id] = workspaces.list().workspaces.map((workspace) => workspace.id);
    const user = answers();
    expect(await workspaces.showMenu(id ?? '', 'src/app', user.ui)).toBe('open-in-terminal');
    expect(user.folderMenus()).toBe(1);
    expect(user.menu()).toBeUndefined();
    const nobody = answers();
    expect(await workspaces.showMenu('unknown', 'src', nobody.ui)).toBeNull();
    expect(nobody.folderMenus()).toBe(0);
  });

  it('keeps the list and the selection in the app’s data', async () => {
    const data = join(root, 'data');
    const workspaces = new Workspaces(fileStorage(data));
    await workspaces.addFolders([web, api], answers({ trust: { web: false } }).ui);
    workspaces.select(workspaces.list().workspaces[0]?.id ?? '');
    expect(new Workspaces(fileStorage(data)).list()).toEqual(workspaces.list());
  });

  it('starts from stored data without repeats, and with a selection whenever there are workspaces', () => {
    const workspaces = new Workspaces(
      memoryStorage({
        workspaces: [
          { id: 'a', path: web, trusted: true },
          { id: 'a', path: api, trusted: true },
          { id: 'b', path: web, trusted: true },
          { id: 'c', path: api, trusted: false },
        ],
        selectedId: 'gone',
      }),
    );
    expect(workspaces.list()).toEqual({
      workspaces: [
        { id: 'a', name: 'web', path: web, trusted: true },
        { id: 'c', name: 'api', path: api, trusted: false },
      ],
      selectedId: 'a',
    });
  });

  it('lists a workspace’s folders, and refuses a workspace that is not on the list', async () => {
    const workspaces = new Workspaces(memoryStorage());
    mkdirSync(join(web, 'src'));
    writeFileSync(join(web, 'src', 'main.ts'), '');
    await workspaces.addFolders([web], answers().ui);
    const id = workspaces.list().selectedId ?? '';
    expect(await workspaces.listFolder(id, 'src')).toEqual({
      entries: [{ name: 'main.ts', kind: 'file' }],
    });
    await expect(workspaces.listFolder(id, '../api')).rejects.toThrow();
    await expect(workspaces.listFolder('unknown', '')).rejects.toThrow('not on the list');
  });
});
