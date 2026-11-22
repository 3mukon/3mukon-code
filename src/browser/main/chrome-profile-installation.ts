import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { waitForLocalChromeExtension } from './chrome-local-setup';
import { ChromeProfileConnection } from './chrome-profile';
import { installedChrome, supportsChrome } from './chrome-version';

const exec = promisify(execFile);
const nativeHost = 'io.github.sanmukon.browser';
const extensionId = z.string().regex(/^[a-p]{32}$/);
const connectorDescriptor = z.strictObject({ extensionId });
const profileDirectory = /^(Default|Profile [1-9][0-9]{0,3})$/;
const localState = z.object({
  profile: z.object({ info_cache: z.record(z.string(), z.object({ name: z.string() })) }),
});

// Chrome owns profile names. Project only the display name and directory key
// from this metadata file. No profile preferences, pages or sign-ins are loaded.
export async function chromeProfileNames(directory: string) {
  try {
    const path = join(directory, 'Local State');
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return [];
    const { profile } = localState.parse(JSON.parse(await readFile(path, 'utf8')));
    return Object.entries(profile.info_cache)
      .filter(([id, entry]) => profileDirectory.test(id) && entry.name.trim())
      .map(([id, entry]) => ({ id, name: entry.name.trim().slice(0, 256) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export async function stagedChromeConnection(
  resourcesPath: string,
  appData: string,
): Promise<ChromeProfileConnection | undefined> {
  const stage = join(resourcesPath, 'chrome-connector');
  const descriptor = join(stage, 'connector.json');
  const hostExecutable = join(stage, 'BrowserHost');
  const bundledExtension = join(stage, 'extension');
  try {
    const info = await lstat(descriptor);
    if (!info.isFile() || info.size > 1024) return;
    const { extensionId } = connectorDescriptor.parse(
      JSON.parse(await readFile(descriptor, 'utf8')),
    );
    const host = await lstat(hostExecutable);
    if (!host.isFile() || !(host.mode & 0o100)) return;
    if (!(await lstat(bundledExtension)).isDirectory()) return;
    const browser = await installedChrome();
    if (!browser || !supportsChrome(browser.version)) return;
    return chromeProfileConnection({
      appData,
      browserData: join(homedir(), 'Library/Application Support/Google/Chrome'),
      browserBundle: browser.bundle,
      browserExecutable: join(browser.bundle, 'Contents', 'MacOS', 'Google Chrome'),
      hostExecutable,
      extensionId,
      bundledExtension,
    });
  } catch {
    return undefined;
  }
}

export function chromeProfileConnection(setup: {
  appData: string;
  browserData: string;
  browserBundle: string;
  browserExecutable: string;
  browserEnvironment?: NodeJS.ProcessEnv;
  hostExecutable: string;
  extensionId: string;
  bundledExtension: string;
}): ChromeProfileConnection {
  const id = extensionId.parse(setup.extensionId);
  const origin = 'chrome-extension://' + id;
  const directory = join(setup.appData, 'chrome-link');
  const installedHost = join(directory, 'BrowserHost');
  const localExtension = join(directory, 'extension');
  const manifests = join(setup.browserData, 'NativeMessagingHosts');
  const manifestPath = join(manifests, nativeHost + '.json');
  const manifest = JSON.stringify({
    name: nativeHost,
    description: 'The 3mukon-code Chrome browser connector',
    path: installedHost,
    type: 'stdio',
    allowed_origins: [origin + '/'],
  });
  const openInProfile = (profile: string, address: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        setup.browserExecutable,
        ['--user-data-dir=' + setup.browserData, '--profile-directory=' + profile, address],
        { detached: true, stdio: 'ignore', env: setup.browserEnvironment },
      );
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  };
  return new ChromeProfileConnection(directory, {
    profiles: () => chromeProfileNames(setup.browserData),
    async prepareHost() {
      const host = await lstat(setup.hostExecutable);
      if (!host.isFile() || !(host.mode & 0o100)) throw new Error('Browser host is unavailable.');
      await keepExtensionFolder(setup.bundledExtension, localExtension);
      await mkdir(manifests, { recursive: true });
      const existing = await lstat(manifestPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      });
      if (
        existing &&
        (!existing.isFile() ||
          existing.uid !== process.getuid?.() ||
          existing.size > 4096 ||
          (await readFile(manifestPath, 'utf8')) !== manifest)
      )
        throw new Error('A different browser host is registered.');

      const staging = installedHost + '.' + randomUUID();
      try {
        await copyFile(setup.hostExecutable, staging);
        await chmod(staging, 0o700);
        await rename(staging, installedHost);
      } finally {
        await rm(staging, { force: true });
      }
      if (!existing) await writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
    },
    async openSetup(profile, ticket, signal, install) {
      await waitForLocalChromeExtension(
        id,
        (url) => openInProfile(profile, url, signal),
        () => {
          install(localExtension);
        },
        signal,
      );
      await openInProfile(profile, origin + '/pair.html#' + ticket, signal);
    },
    async activate() {
      await exec('/usr/bin/open', ['-a', setup.browserBundle], { timeout: 3000 });
    },
  });
}

// Chrome remembers the folder selected at Load unpacked. Keep its path in app data
// so a moved app bundle or a process restart does not change that registration.
async function keepExtensionFolder(source: string, destination: string): Promise<void> {
  const existing = await lstat(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.uid !== process.getuid?.())
      throw new Error('The Chrome extension folder is unavailable.');
    return;
  }
  const stage = destination + '.' + randomUUID();
  try {
    await cp(source, stage, { recursive: true, force: false, errorOnExist: true });
    await rename(stage, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
