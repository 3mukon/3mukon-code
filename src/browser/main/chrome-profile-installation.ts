import { execFile, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { chromeConnector, extensionBuild } from './chrome-connector';
import { waitForLocalChromeExtension } from './chrome-local-setup';
import { ChromeProfileConnection, type ChromeProfileList } from './chrome-profile';
import { installedChrome, supportsChrome } from './chrome-version';

const exec = promisify(execFile);
const extensionId = z.string().regex(/^[a-p]{32}$/);
const connectorDescriptor = z.strictObject({ extensionId });
const profileDirectory = /^(Default|Profile [1-9][0-9]{0,3})$/;
const localState = z.object({
  profile: z.object({ info_cache: z.record(z.string(), z.unknown()) }),
});
const profileName = z.object({ name: z.string().trim().min(1) });

// Project only the profile names and directory keys, never read a profile's preferences or sign-ins.
// macOS 27 protects Chrome's data folder: a read it refuses fails without a prompt, and the user's
// selection of the folder in the system picker lets the app read it, also after the app starts
// again, until the Mac restarts. So the index is always read first, and a refused read asks for the
// folder.
async function readChromeProfiles(directory: string): Promise<ChromeProfileList> {
  try {
    const path = join(directory, 'Local State');
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return { status: 'unavailable' };
    const { profile } = localState.parse(JSON.parse(await readFile(path, 'utf8')));
    const profiles = Object.entries(profile.info_cache)
      .flatMap(([id, entry]) => {
        if (!profileDirectory.test(id)) return [];
        const parsed = profileName.safeParse(entry);
        return parsed.success ? [{ id, name: parsed.data.name.slice(0, 256) }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { status: 'read', profiles };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { status: 'read', profiles: [] };
    if (code === 'EACCES' || code === 'EPERM') return { status: 'access-required' };
    return { status: 'unavailable' };
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
    const build = await extensionBuild(bundledExtension);
    if (build === undefined) return;
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
      build,
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
  build: string;
}): ChromeProfileConnection {
  const id = extensionId.parse(setup.extensionId);
  const directory = join(setup.appData, 'chrome-link');
  const connector = chromeConnector({
    directory,
    browserData: setup.browserData,
    hostExecutable: setup.hostExecutable,
    bundledExtension: setup.bundledExtension,
    extensionId: id,
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
    build: setup.build,
    profiles: () => readChromeProfiles(setup.browserData),
    // The selection is what lets macOS give the app the folder; the next read uses it.
    async selectProfileFolder(pick) {
      const selected = await pick(setup.browserData);
      if (selected === undefined) return { status: 'cancelled-before-dispatch', effects: 'none' };
      // Do not accept another Chrome root, a profile subdirectory or an arbitrary path: the window
      // names this refusal as a folder that isn't Chrome's.
      if (resolve(selected) !== resolve(setup.browserData))
        return { status: 'refused', code: 'invalid-request', dispatched: false };
      return { status: 'verified', value: null };
    },
    install: () => connector.install(),
    renew: () => connector.renew(),
    async openSetup(profile, ticket, signal, install) {
      await waitForLocalChromeExtension(
        { id, build: setup.build },
        (url) => openInProfile(profile, url, signal),
        () => {
          install(connector.extension);
        },
        signal,
      );
      await openInProfile(profile, `chrome-extension://${id}/pair.html#${ticket}`, signal);
    },
    async activate() {
      await exec('/usr/bin/open', ['-a', setup.browserBundle], { timeout: 3000 });
    },
  });
}
