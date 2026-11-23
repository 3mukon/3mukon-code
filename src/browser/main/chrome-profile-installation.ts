import { execFile, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { chromeConnector, extensionBuild } from './chrome-connector';
import { waitForLocalChromeExtension } from './chrome-local-setup';
import { ChromeProfileConnection } from './chrome-profile';
import { installedChrome, supportsChrome } from './chrome-version';

const exec = promisify(execFile);
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
    profiles: () => chromeProfileNames(setup.browserData),
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
