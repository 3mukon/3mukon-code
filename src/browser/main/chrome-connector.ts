import { randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';

const nativeHost = 'io.github.sanmukon.browser';
// Names the build of the extension, for the worker that runs it and for what reads its folder.
const buildFile = 'build.js';
const buildLine = /^export const build = '([a-z0-9]{1,64})';\s*$/;
const registration = z.object({ path: z.string() });

// What the app installs for Chrome: its native host and extension in app data, and the host's
// registration in Chrome's data. An update of the app brings a newer build of them, so what is
// installed is renewed as the app starts.
export interface ChromeConnector {
  // Installs what is missing and renews the rest, as the user's Connect asks.
  install(): Promise<void>;
  // Renews what is installed and leaves the rest alone.
  renew(): Promise<void>;
  // Where Chrome loads the extension from.
  extension: string;
}

export function chromeConnector(setup: {
  directory: string;
  browserData: string;
  hostExecutable: string;
  bundledExtension: string;
  extensionId: string;
}): ChromeConnector {
  const host = join(setup.directory, 'BrowserHost');
  const extension = join(setup.directory, 'extension');
  const manifest = join(setup.browserData, 'NativeMessagingHosts', nativeHost + '.json');
  const wanted = JSON.stringify({
    name: nativeHost,
    description: 'The 3mukon-code Chrome browser connector',
    path: host,
    type: 'stdio',
    allowed_origins: ['chrome-extension://' + setup.extensionId + '/'],
  });

  // The registration Chrome has: none, this app's, or one that another app or app data made.
  async function registered(): Promise<'none' | 'own' | 'other'> {
    const found = await owned(manifest);
    if (found === null) return 'none';
    if (!found?.isFile() || found.size > 4096) return 'other';
    try {
      const { path } = registration.parse(JSON.parse(await readFile(manifest, 'utf8')));
      return path === host ? 'own' : 'other';
    } catch {
      return 'other';
    }
  }

  async function renewHost(): Promise<void> {
    await renewFile(host, await readFile(setup.hostExecutable), 0o700);
  }

  async function renewExtension(): Promise<void> {
    if (!(await owned(extension))?.isDirectory())
      throw new Error('The Chrome extension folder is unavailable.');
    const entries = await readdir(setup.bundledExtension, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(setup.bundledExtension, join(entry.parentPath, entry.name)));
    // The build's name goes last, so that a folder that names this build holds all of it.
    for (const file of [...files.filter((name) => name !== buildFile), buildFile]) {
      const path = join(extension, file);
      await mkdir(dirname(path), { recursive: true });
      await renewFile(path, await readFile(join(setup.bundledExtension, file)), 0o600);
    }
  }

  return {
    extension,
    async install() {
      const bundled = await lstat(setup.hostExecutable);
      if (!bundled.isFile() || !(bundled.mode & 0o100))
        throw new Error('Browser host is unavailable.');
      if ((await registered()) === 'other')
        throw new Error('A different browser host is registered.');
      if ((await owned(extension)) === null) {
        // A folder Chrome may load appears whole.
        const stage = extension + '.' + randomUUID();
        try {
          await cp(setup.bundledExtension, stage, { recursive: true, force: false });
          await rename(stage, extension);
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      } else await renewExtension();
      await renewHost();
      await mkdir(dirname(manifest), { recursive: true });
      await renewFile(manifest, Buffer.from(wanted), 0o600);
    },
    async renew() {
      if ((await owned(extension)) !== null) await renewExtension();
      if ((await owned(host))?.isFile()) await renewHost();
      if ((await registered()) === 'own') await renewFile(manifest, Buffer.from(wanted), 0o600);
    },
  };
}

// The build the extension in a folder names, or undefined where it names none.
export async function extensionBuild(folder: string): Promise<string | undefined> {
  const source = await readFile(join(folder, buildFile), 'utf8').catch(() => '');
  return buildLine.exec(source)?.[1];
}

// What a path holds where the user owns it, undefined where another does, and null where there is
// nothing.
async function owned(path: string) {
  const found = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    return null;
  });
  return found === null || found.uid === process.getuid?.() ? found : undefined;
}

// Gives a file these bytes in one step where it has others, so that a program reading or running it
// keeps the file it opened.
async function renewFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const current = await readFile(path).catch(() => null);
  if (current?.equals(bytes)) return;
  const staged = path + '.' + randomUUID();
  try {
    await writeFile(staged, bytes, { flag: 'wx', mode });
    await chmod(staged, mode);
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}
