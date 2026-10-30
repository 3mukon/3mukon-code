import { isAbsolute, normalize } from 'node:path';
import type { OpenedFile, SaveResult } from '../shared/files';
import { readText, writeText } from './text-files';
import { FileWatcher } from './watch';

// The files the window's editors read, write and watch. Only some files are open to them: those
// inside a workspace's folder, those dropped on the window from the Finder, and those an editor has
// opened, which stay open to it for the app's run, should their workspace be removed meanwhile. A path
// must be absolute and in its plain form, without . or .. parts, so that none reaches elsewhere.
export class FileService {
  private readonly granted = new Set<string>();
  private readonly watching = new Map<number, ReadonlySet<string>>();
  private readonly listeners = new Set<(path: string) => void>();
  private readonly watcher: FileWatcher;

  // The folders of the user's workspaces, absolute and with links resolved.
  constructor(
    private readonly workspaceFolders: () => readonly string[],
    settleMs?: number,
  ) {
    this.watcher = new FileWatcher((path) => {
      for (const listener of this.listeners) listener(path);
    }, settleMs);
  }

  // Files dropped on the window from the Finder, which its editors may then open.
  grant(paths: readonly string[]): void {
    for (const path of paths) if (plain(path)) this.granted.add(path);
  }

  async open(path: string): Promise<OpenedFile> {
    if (!this.allows(path)) return { kind: 'notice', notice: 'outside' };
    const file = await readText(path);
    if (file.kind === 'text') this.granted.add(path);
    return file;
  }

  async save(path: string, text: string): Promise<SaveResult> {
    if (!this.allows(path)) return { saved: false, reason: 'outside' };
    return writeText(path, text);
  }

  // The files a window's editors show, by the window's id; each call replaces that window's last
  // list. Files not open to the editors are left out.
  watch(windowId: number, paths: readonly string[]): void {
    this.watching.set(windowId, new Set(paths.filter((path) => this.allows(path))));
    this.updateWatcher();
  }

  // A window closed, or its page loaded again: its files are watched no more.
  forget(windowId: number): void {
    if (this.watching.delete(windowId)) this.updateWatcher();
  }

  // Hears of each change on disk to a file some window watches.
  onChange(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.watcher.close();
  }

  private allows(path: string): boolean {
    if (!plain(path)) return false;
    return (
      this.granted.has(path) ||
      this.workspaceFolders().some((folder) =>
        path.startsWith(folder.endsWith('/') ? folder : `${folder}/`),
      )
    );
  }

  private updateWatcher(): void {
    this.watcher.set(new Set([...this.watching.values()].flatMap((paths) => [...paths])));
  }
}

function plain(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && !path.endsWith('/');
}
