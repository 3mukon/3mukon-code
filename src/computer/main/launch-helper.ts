import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ControlEvent } from '../shared/computer';
import { HELPER_NAME } from '../shared/helper';
import { NativeHelper } from './helper';
import type { HelperChild } from './helper-wire';
import { installHelper } from './install-helper';

const exec = promisify(execFile);
const BUNDLE_ID = 'io.github.3mukon.3mukon-code.computer-use';
const identity = z.strictObject({ certificate: z.string().regex(/^[0-9A-Fa-f]{40}$/) });

export function nativeHelper(options: {
  data: string;
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
  osVersion: string;
  onGenerationEnded?: (id: string) => void;
  onControl?: (revision: number, command: ControlEvent) => void;
  onStopShortcut?: (registers: boolean) => void;
}): NativeHelper {
  return new NativeHelper(
    async () => {
      if (Number(options.osVersion.split('.')[0]) < 14)
        throw new Error('The native helper requires macOS 14.');
      const artifacts = options.packaged
        ? join(dirname(options.resourcesPath), 'Helpers')
        : join(options.appPath, 'out', 'native');
      const bundle = join(artifacts, HELPER_NAME + '.app');
      const executable = join('Contents', 'MacOS', 'AutomationHelper');
      const manifest = options.packaged
        ? join(options.appPath, 'out', 'native-helper-identity.json')
        : join(artifacts, 'native-helper-identity.json');
      const file = await lstat(manifest);
      if (!file.isFile() || file.size > 256) throw new Error('No native helper identity.');
      const read: unknown = JSON.parse(await readFile(manifest, 'utf8'));
      const { certificate } = identity.parse(read);
      if (!(await lstat(bundle)).isDirectory() || !(await lstat(join(bundle, executable))).isFile())
        throw new Error('The native helper bundle is missing.');
      const requirement =
        'identifier "' + BUNDLE_ID + '" and certificate leaf = H"' + certificate + '"';
      const root = await privateFolder(join(options.data, 'computer-use'));
      const locks = await privateFolder(join(root, 'coordination'));
      const temporary = await privateFolder(join(root, 'temporary'));
      const installed = await installHelper(bundle, root, async (checked) => {
        await exec(
          '/usr/bin/codesign',
          ['--verify', '--strict', '--deep', '-R', '=' + requirement, checked],
          {
            timeout: 2_500,
            maxBuffer: 4096,
          },
        );
      });
      return launch(join(installed, executable), locks, temporary);
    },
    options.onGenerationEnded,
    options.onControl,
    options.onStopShortcut,
  );
}

async function privateFolder(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const found = await lstat(path);
  if (!found.isDirectory() || found.uid !== process.getuid?.() || (found.mode & 0o077) !== 0)
    throw new Error('The native helper needs its own private coordination folder.');
  return path;
}

async function launch(binary: string, root: string, temporary: string): Promise<HelperChild> {
  const child = spawn(binary, ['--coordination-root', root], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', TMPDIR: temporary, LANG: 'en_US.UTF-8' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let ended = false;
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  const exit = new Promise<void>((resolve) => {
    child.once('close', () => {
      ended = true;
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid;
  if (!pid) throw new Error('The native helper did not start.');
  return {
    pid,
    input: child.stdin,
    output: child.stdout,
    exit,
    async stop() {
      if (!ended) {
        child.stdin.end();
        // EOF is the normal exit. Escalate only for this exact child if it is still running.
        const terminate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        }, 1_500);
        const kill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2_500);
        await exit.finally(() => {
          clearTimeout(terminate);
          clearTimeout(kill);
        });
      }
    },
  };
}
