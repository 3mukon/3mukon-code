import { lstat, mkdir, mkdtemp, readdir, rename, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareVersions, isVersion } from '../shared/version';

// How long a copy that no build of the app runs stays. Builds that share the app's data folder, such
// as a development build beside a packaged app, may each run another version, and each keeps its own
// copy in use by running it.
const UNUSED_COPY_MS = 7 * 24 * 60 * 60 * 1000;
const PARTIAL = '.partial-';

// The app's data folder would not take a copy: a folder on the way is a link, not a folder, someone
// else's, or one that others may write to.
export class FolderError extends Error {
  constructor(folder: string) {
    super(`The folder for the providers' copies is not the app's own: ${folder}`);
    this.name = 'FolderError';
  }
}

// The app's own copies of one provider's CLI (ADR-0039): a folder for each version in the provider's
// folder of the app's data, which appears under the version's name only once it is whole. Copies are
// run from there only while every folder on the way is the user's own and only they may write to it,
// and the binary is a file only they may change.
export class Copies {
  constructor(
    // The provider's folder, in the folder of all the providers' copies.
    private readonly folder: string,
    private readonly now: () => number = Date.now,
  ) {}

  // The copy of the version, where the folder holds it whole: the path of its binary.
  async get(version: string, binary: string): Promise<string | null> {
    if (!isVersion(version) || !(await this.ours())) return null;
    const path = join(this.folder, version, binary);
    return (await isPrivateExecutable(path)) ? path : null;
  }

  // The versions the folder holds copies of, newest first.
  async versions(): Promise<string[]> {
    const names = await readdir(this.folder).catch(() => []);
    return names.filter(isVersion).sort((a, b) => compareVersions(b, a));
  }

  // Marks the version's copy as run now, which keeps it, and removes the copies that no build has run
  // for a week.
  async markRun(version: string): Promise<void> {
    const now = new Date(this.now());
    await utimes(join(this.folder, version), now, now).catch(() => undefined);
    await this.removeUnused(version);
  }

  // Removes the copies no build has run for a week, and the partial ones a download left that long
  // ago; a partial copy being made is new and stays. One that cannot be removed waits for the next
  // time.
  async removeUnused(keep?: string): Promise<void> {
    const names = await readdir(this.folder).catch(() => []);
    await Promise.all(
      names
        .filter((name) => name !== keep && (isVersion(name) || name.startsWith(PARTIAL)))
        .map(async (name) => {
          const path = join(this.folder, name);
          const found = await lstat(path).catch(() => undefined);
          if (found === undefined || this.now() - found.mtimeMs < UNUSED_COPY_MS) return;
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
        }),
    );
  }

  // A new folder to make a copy in, the user's alone, in the provider's folder, which it makes where it
  // is missing. Rejects with FolderError where the provider's folder is not the app's own.
  async staging(): Promise<string> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    if (!(await this.ours())) throw new FolderError(this.folder);
    return mkdtemp(join(this.folder, PARTIAL));
  }

  // Puts the copy that was made in a staging folder in place as the version's, whole, and resolves with
  // the path of its binary. A whole copy of the version that is there already stays, and one that is
  // not whole is replaced.
  async commit(made: string, version: string, binary: string): Promise<string> {
    const target = join(this.folder, version);
    const existing = await this.get(version, binary);
    if (existing !== null) return existing;
    await rm(target, { recursive: true, force: true });
    try {
      await rename(made, target);
    } catch (error) {
      // Another build or window put a whole copy there first.
      const raced = await this.get(version, binary);
      if (raced !== null) return raced;
      throw error;
    }
    const path = await this.get(version, binary);
    if (path === null)
      throw new Error(`The copy of ${version} has no binary the user alone may run.`);
    return path;
  }

  // Whether the provider's folder and the folder of all the providers' copies are the user's own.
  private async ours(): Promise<boolean> {
    return (await isOwnFolder(this.folder)) && (await isOwnFolder(dirname(this.folder)));
  }
}

async function isOwnFolder(path: string): Promise<boolean> {
  const found = await lstat(path).catch(() => undefined);
  return (
    found !== undefined &&
    !found.isSymbolicLink() &&
    found.isDirectory() &&
    found.uid === process.getuid?.() &&
    (found.mode & 0o022) === 0
  );
}

// A file, not a link, of the user's, that only they may change and that they may run.
export async function isPrivateExecutable(path: string): Promise<boolean> {
  const found = await lstat(path).catch(() => undefined);
  return (
    found !== undefined &&
    found.isFile() &&
    found.size > 0 &&
    found.uid === process.getuid?.() &&
    (found.mode & 0o022) === 0 &&
    (found.mode & 0o100) !== 0
  );
}
