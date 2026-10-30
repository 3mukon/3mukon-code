import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EDITABLE_BYTES } from '../shared/files';
import { readText, writeText } from './text-files';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'text-files-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readText', () => {
  it('reads UTF-8 text with its line breaks as they are', async () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\r\nconst é = 2;\r\n');
    expect(await readText(join(root, 'a.ts'))).toEqual({
      kind: 'text',
      text: 'const a = 1;\r\nconst é = 2;\r\n',
      bom: false,
    });
  });

  it('leaves out a byte order mark, and notes it', async () => {
    writeFileSync(join(root, 'bom.txt'), '﻿hé');
    expect(await readText(join(root, 'bom.txt'))).toEqual({ kind: 'text', text: 'hé', bom: true });
  });

  it('opens a file with a NUL byte, or of bytes that are not UTF-8, as a notice', async () => {
    writeFileSync(join(root, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await readText(join(root, 'nul.bin'))).toEqual({ kind: 'notice', notice: 'binary' });
    expect(await readText(join(root, 'latin1.txt'))).toEqual({ kind: 'notice', notice: 'binary' });
  });

  it('opens a file up to the editor’s size, and a larger one as a notice', async () => {
    writeFileSync(join(root, 'full.txt'), 'a'.repeat(MAX_EDITABLE_BYTES));
    writeFileSync(join(root, 'large.txt'), '');
    truncateSync(join(root, 'large.txt'), MAX_EDITABLE_BYTES + 1);
    expect((await readText(join(root, 'full.txt'))).kind).toBe('text');
    expect(await readText(join(root, 'large.txt'))).toEqual({
      kind: 'notice',
      notice: 'too-large',
    });
  });

  it('opens a missing file, a folder and a file it may not read as notices', async () => {
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'secret.txt'), 'x');
    chmodSync(join(root, 'secret.txt'), 0o000);
    expect(await readText(join(root, 'gone.txt'))).toEqual({ kind: 'notice', notice: 'missing' });
    expect(await readText(join(root, 'folder'))).toEqual({ kind: 'notice', notice: 'unreadable' });
    expect(await readText(join(root, 'secret.txt'))).toEqual({
      kind: 'notice',
      notice: 'unreadable',
    });
  });
});

describe('writeText', () => {
  it('writes UTF-8 over the file through a link, which stays a link, keeping the permissions', async () => {
    writeFileSync(join(root, 'target.txt'), 'old text that is longer');
    chmodSync(join(root, 'target.txt'), 0o640);
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));
    expect(await writeText(join(root, 'link.txt'), 'nouveau\n')).toEqual({ saved: true });
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('nouveau\n');
    expect(lstatSync(join(root, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(statSync(join(root, 'target.txt')).mode & 0o777).toBe(0o640);
  });

  it('writes a missing file again in its folder', async () => {
    expect(await writeText(join(root, 'new.txt'), 'x')).toEqual({ saved: true });
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('x');
  });

  it('says when the user may not write the file, or when writing fails otherwise', async () => {
    writeFileSync(join(root, 'locked.txt'), 'x');
    chmodSync(join(root, 'locked.txt'), 0o400);
    expect(await writeText(join(root, 'locked.txt'), 'y')).toEqual({
      saved: false,
      reason: 'denied',
    });
    expect(await writeText(join(root, 'gone', 'a.txt'), 'y')).toEqual({
      saved: false,
      reason: 'failed',
    });
  });
});
