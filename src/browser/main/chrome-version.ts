import { homedir } from 'node:os';
import { join } from 'node:path';
import { installedBrowser } from './browser-installation';

export const MINIMUM_CHROME_VERSION = '158.0.8127.2';

export function supportsChrome(version: string): boolean {
  const minimum = MINIMUM_CHROME_VERSION.split('.').map(Number);
  const actual = version.split('.').map(Number);
  for (const [index, expected] of minimum.entries()) {
    const part = actual[index];
    if (part === undefined) return false;
    if (part !== expected) return part > expected;
  }
  return true;
}

export function installedChrome(): Promise<{ version: string; bundle: string } | null> {
  return installedBrowser(
    ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')],
    'com.google.Chrome',
    /^\d{1,5}(?:\.\d{1,5}){3}$/,
  );
}

export async function installedChromeVersion(): Promise<string | null> {
  return (await installedChrome())?.version ?? null;
}
