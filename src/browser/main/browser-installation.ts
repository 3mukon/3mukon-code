import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const manifest = z.object({
  CFBundleIdentifier: z.string(),
  CFBundleShortVersionString: z.string(),
});
const exec = promisify(execFile);

export async function installedBrowser(
  bundles: readonly string[],
  identifier: string,
  versionPattern: RegExp,
): Promise<{ version: string; bundle: string } | null> {
  for (const bundle of bundles) {
    try {
      const { stdout } = await exec(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')],
        { timeout: 1_500, maxBuffer: 64 * 1024 },
      );
      const info = manifest.safeParse(JSON.parse(stdout) as unknown);
      if (
        info.success &&
        info.data.CFBundleIdentifier === identifier &&
        versionPattern.test(info.data.CFBundleShortVersionString)
      )
        return { version: info.data.CFBundleShortVersionString, bundle };
    } catch {
      // A browser may be absent or unreadable while macOS replaces the app.
    }
  }
  return null;
}
