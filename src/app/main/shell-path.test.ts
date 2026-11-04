import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginShellPath, pathIn } from './shell-path';

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'shell-path-'));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

// A shell that ignores what it is asked and runs this script instead.
function shell(script: string): string {
  const path = join(folder, 'shell');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

const MARK = '__3MUKON_CODE_PATH__';

describe('loginShellPath', () => {
  it('takes the PATH the shell prints between the marks, whatever its startup files print, and only its absolute folders', async () => {
    const path = await loginShellPath(
      shell(
        `echo "Last login: today"; echo ${MARK}; echo "/opt/homebrew/bin:bin:/usr/bin"; echo ${MARK}`,
      ),
    );
    expect(path).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('gives nothing for a shell that fails, prints no PATH or takes too long', async () => {
    expect(await loginShellPath(shell('exit 1'))).toBeNull();
    expect(await loginShellPath(shell('echo hello'))).toBeNull();
    expect(
      await loginShellPath(shell(`sleep 2; echo ${MARK}; echo /usr/bin; echo ${MARK}`), 200),
    ).toBeNull();
    expect(await loginShellPath(join(folder, 'missing'))).toBeNull();
    expect(pathIn(`${MARK}\n\n${MARK}`)).toBeNull();
  });
});
