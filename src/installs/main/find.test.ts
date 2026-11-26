import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCommand, pathFolders, Versions } from './find';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installs-find-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A CLI of the test's own that prints the given text for its version.
function cli(folder: string, name: string, output: string, mode = 0o755): string {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/sh\necho '${output}'\n`);
  chmodSync(path, mode);
  return path;
}

const codexVersion = (output: string) => /codex-cli (\S+)/.exec(output)?.[1] ?? null;

describe('the PATH’s folders', () => {
  it('are the absolute ones, each once, in order', () => {
    expect(pathFolders('/opt/homebrew/bin::bin:/usr/bin:/opt/homebrew/bin:./x')).toEqual([
      '/opt/homebrew/bin',
      '/usr/bin',
    ]);
    expect(pathFolders(undefined)).toEqual([]);
  });
});

describe('finding a CLI', () => {
  it('takes the first file of the name the user may run, as a terminal does', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    cli(first, 'codex', 'codex-cli 1.0.0', 0o644);
    mkdirSync(join(second, 'codex'), { recursive: true });
    const third = cli(join(root, 'third'), 'codex', 'codex-cli 2.0.0');
    cli(join(root, 'fourth'), 'codex', 'codex-cli 3.0.0');
    const folders = [
      join(root, 'missing'),
      first,
      second,
      join(root, 'third'),
      join(root, 'fourth'),
    ];
    expect(await findCommand('codex', folders)).toBe(third);
    expect(await findCommand('claude', folders)).toBeNull();
  });
});

describe('a CLI’s version', () => {
  it('is read once for each file as it is, and anew once the file changes', async () => {
    const path = cli(root, 'codex', 'codex-cli 0.171.0');
    const run = vi.fn((file: string) =>
      Promise.resolve(`codex-cli ${file === path ? '0.171.0' : ''}`),
    );
    const versions = new Versions(run);
    expect(await versions.read(path, codexVersion)).toBe('0.171.0');
    expect(await versions.read(path, codexVersion)).toBe('0.171.0');
    expect(run).toHaveBeenCalledTimes(1);
    writeFileSync(path, '#!/bin/sh\necho "codex-cli 0.172.0 (updated)"\n');
    run.mockResolvedValueOnce('codex-cli 0.172.0');
    expect(await versions.read(path, codexVersion)).toBe('0.172.0');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs the CLI with --version, and asks again after a minute where it could not be read', async () => {
    const path = cli(root, 'codex', 'codex-cli 0.171.0');
    let now = 0;
    const versions = new Versions(undefined, () => now);
    expect(await versions.read(path, codexVersion)).toBe('0.171.0');
    const silent = cli(join(root, 'other'), 'codex', 'no version here');
    expect(await versions.read(silent, codexVersion)).toBeNull();
    now = 30_000;
    expect(await versions.read(silent, () => '9.9.9')).toBeNull();
    now = 61_000;
    expect(await versions.read(silent, () => '9.9.9')).toBe('9.9.9');
    expect(await versions.read(join(root, 'none'), codexVersion)).toBeNull();
  });

  it('takes nothing for a version that is not one', async () => {
    const path = cli(root, 'grok', 'grok ../../etc');
    expect(
      await new Versions().read(path, (output) => /grok (\S+)/.exec(output)?.[1] ?? null),
    ).toBeNull();
  });
});
