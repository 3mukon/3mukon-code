import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { isVersion } from '../shared/version';

const run = promisify(execFile);

// How long a CLI may take to print its version, and how long the app waits before it asks again a CLI
// whose version it could not read.
const VERSION_TIMEOUT_MS = 10_000;
const RETRY_MS = 60_000;

// The folders of a PATH that the app looks in for a provider's CLI: the absolute ones, each once, in
// order. A terminal reads an empty or relative entry as the folder it is in, which the app has none of.
export function pathFolders(path: string | undefined): string[] {
  const folders: string[] = [];
  for (const folder of (path ?? '').split(delimiter)) {
    if (isAbsolute(folder) && !folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

// The first file of the name in the folders that the user may run, as a terminal finds a command; null
// where there is none.
export async function findCommand(
  command: string,
  folders: readonly string[],
): Promise<string | null> {
  for (const folder of folders) {
    const path = join(folder, command);
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Not there, or not one the user may run.
    }
  }
  return null;
}

// What a CLI prints for `--version`, its standard output and standard error together, as the
// provider's process would run in the app's environment.
export type RunVersion = (path: string) => Promise<string>;

export async function runVersion(path: string): Promise<string> {
  const { stdout, stderr } = await run(path, ['--version'], {
    cwd: homedir(),
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env: process.env,
  });
  return `${stdout}\n${stderr}`;
}

// The versions of the CLIs the app finds, read once for each file as it is, by its real path, size,
// modification time and inode, so that a CLI the user updates is read anew; a CLI whose version could
// not be read is asked again after a minute.
export class Versions {
  private readonly known = new Map<string, { version: string | null; at: number }>();
  private readonly reading = new Map<string, Promise<string | null>>();

  constructor(
    private readonly run: RunVersion = runVersion,
    private readonly now: () => number = Date.now,
  ) {}

  async read(path: string, parse: (output: string) => string | null): Promise<string | null> {
    let key: string;
    try {
      const real = await realpath(path);
      const found = await stat(real);
      key = JSON.stringify([real, found.size, found.mtimeMs, found.ino]);
    } catch {
      return null;
    }
    const known = this.known.get(key);
    if (known !== undefined && (known.version !== null || this.now() - known.at < RETRY_MS)) {
      return known.version;
    }
    let reading = this.reading.get(key);
    if (reading === undefined) {
      reading = this.run(path)
        .then((output) => {
          const version = parse(output);
          return version !== null && isVersion(version) ? version : null;
        })
        .catch(() => null)
        .then((version) => {
          this.known.set(key, { version, at: this.now() });
          this.reading.delete(key);
          return version;
        });
      this.reading.set(key, reading);
    }
    return reading;
  }
}
