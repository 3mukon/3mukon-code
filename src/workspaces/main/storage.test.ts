import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileStorage } from './storage';

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'storage-'));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const stored = {
  workspaces: [{ id: 'w1', path: '/Users/me/web', trusted: false }],
  selectedId: 'w1',
};

describe('fileStorage', () => {
  it('keeps the workspaces in workspaces.json, readable by the user alone', () => {
    fileStorage(folder).save(stored);
    const file = join(folder, 'workspaces.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(stored);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(fileStorage(folder).load()).toEqual(stored);
  });

  it('starts without workspaces when there is no file yet', () => {
    expect(fileStorage(folder).load()).toEqual({ workspaces: [], selectedId: null });
  });

  it('starts without workspaces when the file is not JSON or holds something else', () => {
    const file = join(folder, 'workspaces.json');
    writeFileSync(file, '{ not json');
    expect(fileStorage(folder).load()).toEqual({ workspaces: [], selectedId: null });
    writeFileSync(file, JSON.stringify({ workspaces: [{ id: 1 }], selectedId: null }));
    expect(fileStorage(folder).load()).toEqual({ workspaces: [], selectedId: null });
  });
});
