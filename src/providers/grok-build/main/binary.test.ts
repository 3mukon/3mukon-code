import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledGrokBinary, bundledGrokPackage, type GrokPackage } from './binary';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the bundled binary', () => {
  let root: string;
  let bundled: GrokPackage;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grok-binary-'));
    const compressed = join(root, 'grok.br');
    writeFileSync(compressed, brotliCompressSync(Buffer.from('#!/bin/sh\necho grok\n')));
    bundled = { version: '1.2.3', compressed };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is unpacked into the folder once per version, for the user alone', async () => {
    const folder = join(root, 'cache');
    const binary = await bundledGrokBinary(folder, bundled);
    expect(binary).toBe(join(folder, 'grok-1.2.3'));
    expect(readFileSync(binary, 'utf8')).toBe('#!/bin/sh\necho grok\n');
    expect(statSync(binary).mode & 0o777).toBe(0o700);
    expect(statSync(folder).mode & 0o077).toBe(0);
    const before = statSync(binary).ino;
    expect(await bundledGrokBinary(folder, bundled)).toBe(binary);
    expect(statSync(binary).ino).toBe(before);
    expect(readdirSync(folder)).toEqual(['grok-1.2.3']);
  });

  it('replaces a binary that is not a private executable', async () => {
    const folder = join(root, 'cache');
    mkdirSync(folder, { mode: 0o700 });
    const binary = join(folder, 'grok-1.2.3');
    writeFileSync(binary, 'tampered');
    chmodSync(binary, 0o766);
    await bundledGrokBinary(folder, bundled);
    expect(readFileSync(binary, 'utf8')).toBe('#!/bin/sh\necho grok\n');
    expect(statSync(binary).mode & 0o777).toBe(0o700);
  });

  it('removes the copies that no build has run for a week, and nothing else', async () => {
    const folder = join(root, 'cache');
    mkdirSync(folder, { mode: 0o700 });
    const age = (path: string, days: number) => {
      const time = new Date(Date.now() - days * DAY_MS);
      utimesSync(path, time, time);
    };
    // Other versions' copies, one another build ran six days ago and one eight days ago; a partial copy
    // being written and one an unpacking left eight days ago; and what is no copy.
    const made: [string, number][] = [
      ['grok-1.2.2', 6],
      ['grok-1.2.1', 8],
      ['.grok-1.2.3-ba9876543210', 0],
      ['.grok-1.2.0-0123456789ab', 8],
      ['notes', 8],
    ];
    for (const [name, days] of made) {
      writeFileSync(join(folder, name), '');
      age(join(folder, name), days);
    }
    mkdirSync(join(folder, 'grok-folder'));
    age(join(folder, 'grok-folder'), 8);
    await bundledGrokBinary(folder, bundled);
    expect(readdirSync(folder).sort()).toEqual([
      '.grok-1.2.3-ba9876543210',
      'grok-1.2.2',
      'grok-1.2.3',
      'grok-folder',
      'notes',
    ]);
    // Once the other build has not run its copy for a week either, the next start removes it.
    age(join(folder, 'grok-1.2.2'), 8);
    await bundledGrokBinary(folder, bundled);
    expect(existsSync(join(folder, 'grok-1.2.2'))).toBe(false);
  });

  it('marks its own copy as run each time, so that other builds keep it', async () => {
    const folder = join(root, 'cache');
    const binary = await bundledGrokBinary(folder, bundled);
    const longAgo = new Date(Date.now() - 30 * DAY_MS);
    utimesSync(binary, longAgo, longAgo);
    const before = statSync(binary).ino;
    await bundledGrokBinary(folder, bundled);
    expect(statSync(binary).ino).toBe(before);
    expect(Date.now() - statSync(binary).mtimeMs).toBeLessThan(DAY_MS);
  });

  it('refuses a folder that others can write to, or that is a link', async () => {
    const open = join(root, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    await expect(bundledGrokBinary(open, bundled)).rejects.toThrow("not the app's own");
    const real = join(root, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, 'link');
    symlinkSync(real, link);
    await expect(bundledGrokBinary(link, bundled)).rejects.toThrow("not the app's own");
    expect(existsSync(join(real, 'grok-1.2.3'))).toBe(false);
  });

  it('comes from the pinned package', () => {
    const { version, compressed } = bundledGrokPackage();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compressed.endsWith(join('grok-darwin-arm64', 'bin', 'grok.br'))).toBe(true);
    expect(existsSync(compressed)).toBe(true);
  });
});
