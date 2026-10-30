import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// How long a file's changes gather before they are reported, as programs often write a file in steps.
const SETTLE_MS = 50;

interface WatchedFolder {
  watcher: FSWatcher;
  names: ReadonlySet<string>;
}

// Watches files through their folders, one watcher per folder, so that a file replaced by a rename,
// as many programs save, or removed and written again is still followed. A change to a watched file
// is reported once its changes have settled; when a folder can no longer be watched, as when it is
// removed, each of its watched files is reported once and the folder is watched no more.
export class FileWatcher {
  private readonly folders = new Map<string, WatchedFolder>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly changed: (path: string) => void,
    private readonly settleMs = SETTLE_MS,
  ) {}

  // Watches these files from now on, and no others.
  set(paths: Iterable<string>): void {
    const wanted = new Map<string, Set<string>>();
    for (const path of paths) {
      const folder = dirname(path);
      const names = wanted.get(folder) ?? new Set<string>();
      names.add(basename(path));
      wanted.set(folder, names);
    }
    for (const [folder, watched] of this.folders) {
      if (!wanted.has(folder)) this.stop(folder, watched);
    }
    for (const [folder, names] of wanted) {
      const watched = this.folders.get(folder);
      if (watched === undefined) this.start(folder, names);
      else this.folders.set(folder, { watcher: watched.watcher, names });
    }
    for (const [path, timer] of this.pending) {
      if (wanted.get(dirname(path))?.has(basename(path)) !== true) {
        clearTimeout(timer);
        this.pending.delete(path);
      }
    }
  }

  close(): void {
    this.set([]);
  }

  private start(folder: string, names: ReadonlySet<string>): void {
    let watcher: FSWatcher;
    try {
      watcher = watch(folder, { persistent: false }, (_event, name) => {
        const watched = this.folders.get(folder);
        if (watched === undefined) return;
        // Without a name, any of the folder's files may have changed.
        for (const each of name === null ? watched.names : [name]) {
          if (watched.names.has(each)) this.report(join(folder, each));
        }
      });
    } catch {
      // A folder that cannot be watched, such as one already removed, reports nothing.
      return;
    }
    watcher.on('error', () => {
      const watched = this.folders.get(folder);
      if (watched?.watcher !== watcher) return;
      this.stop(folder, watched);
      for (const name of watched.names) this.report(join(folder, name));
    });
    this.folders.set(folder, { watcher, names });
  }

  private stop(folder: string, watched: WatchedFolder): void {
    watched.watcher.close();
    this.folders.delete(folder);
  }

  private report(path: string): void {
    clearTimeout(this.pending.get(path));
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        this.changed(path);
      }, this.settleMs),
    );
  }
}
