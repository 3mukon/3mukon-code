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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledGrokBinary, bundledGrokPackage, type GrokPackage } from './binary';

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
