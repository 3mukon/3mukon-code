import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Copies, FolderError } from './copies';

const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let folder: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installs-copies-'));
  folder = join(root, 'providers', 'codex');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A copy made in a staging folder, with its binary in bin/, put in place as the version's, the staging
// folder then removed, as a download does.
async function commit(copies: Copies, version: string, mode = 0o700): Promise<string> {
  const staging = await copies.staging();
  const copy = join(staging, 'copy');
  mkdirSync(join(copy, 'bin'), { recursive: true });
  writeFileSync(join(copy, 'bin', 'codex'), '#!/bin/sh\n');
  chmodSync(join(copy, 'bin', 'codex'), mode);
  try {
    return await copies.commit(copy, version, 'bin/codex');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

describe('the app’s copies', () => {
  it('appear under their version once whole, in folders for the user alone', async () => {
    const copies = new Copies(folder);
    expect(await copies.get('0.171.0', 'bin/codex')).toBeNull();
    const path = await commit(copies, '0.171.0');
    expect(path).toBe(join(folder, '0.171.0', 'bin', 'codex'));
    expect(await copies.get('0.171.0', 'bin/codex')).toBe(path);
    expect(await copies.versions()).toEqual(['0.171.0']);
  });

  it('keep a whole copy already there, and replace one that is not whole', async () => {
    const copies = new Copies(folder);
    const first = await commit(copies, '0.171.0');
    expect(await commit(copies, '0.171.0')).toBe(first);
    rmSync(first);
    expect(await commit(copies, '0.171.0')).toBe(first);
    expect(existsSync(first)).toBe(true);
  });

  it('run none that others may change, nor from a folder that is a link or not the user’s alone', async () => {
    const copies = new Copies(folder);
    await expect(commit(copies, '0.171.0', 0o722)).rejects.toThrow(
      'no binary the user alone may run',
    );
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const linked = new Copies(join(root, 'linked', 'codex'));
    symlinkSync(elsewhere, join(root, 'linked'));
    await expect(linked.staging()).rejects.toBeInstanceOf(FolderError);
    const shared = join(root, 'shared');
    mkdirSync(shared, { mode: 0o777 });
    chmodSync(shared, 0o777);
    await expect(new Copies(join(shared, 'codex')).staging()).rejects.toBeInstanceOf(FolderError);
  });

  it('keep the copies run within a week, and remove the rest and the partial ones', async () => {
    let now = Date.now();
    const copies = new Copies(folder, () => now);
    await commit(copies, '0.170.0');
    await commit(copies, '0.171.0');
    const partial = await copies.staging();
    const old = new Date(now - 8 * DAY_MS);
    utimesSync(join(folder, '0.170.0'), old, old);
    utimesSync(partial, old, old);
    await copies.markRun('0.171.0');
    expect(readdirSync(folder).sort()).toEqual(['0.171.0']);
    now += 8 * DAY_MS;
    await copies.removeUnused();
    expect(readdirSync(folder)).toEqual([]);
  });
});
