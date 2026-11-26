import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordStorage, SessionRecords, type SessionRecord } from './records';

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'records-'));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const claude: SessionRecord = {
  id: 'a1',
  provider: 'claude-code',
  sessionId: 'claude-1',
  cwd: '/Users/me/web',
  title: 'Fix the build',
  activeAt: 1_000,
  archived: true,
  mode: 'yolo',
  gateway: 'work',
  model: null,
  effort: 'high',
  sandbox: 'read-only',
};
const codex: SessionRecord = {
  id: 'a2',
  provider: 'codex-cli',
  sessionId: 'thread-1',
  cwd: '/Users/me/api',
  activeAt: 2_000,
  mode: 'auto',
  gateway: null,
  model: 'gpt-6-astra',
  effort: null,
  sandbox: 'workspace-write',
};

// A storage in memory, which records what was saved.
function memoryStorage(initial: SessionRecord[] = []) {
  const saved: SessionRecord[][] = [];
  return {
    storage: { load: () => initial, save: (records: SessionRecord[]) => saved.push(records) },
    saved,
  };
}

describe('SessionRecords', () => {
  it('keeps each session, and what it becomes, by the app’s id', () => {
    const { storage, saved } = memoryStorage([claude]);
    const records = new SessionRecords(storage);
    records.keep(codex);
    records.keep({ ...claude, title: 'Build fixes' });
    expect(saved.at(-1)).toEqual([{ ...claude, title: 'Build fixes' }, codex]);
    expect(records.get('a2')).toEqual(codex);
    expect(records.get('missing')).toBeUndefined();
    expect(records.all()).toEqual([{ ...claude, title: 'Build fixes' }, codex]);
  });

  it('forgets a session, and saves only when it had one', () => {
    const { storage, saved } = memoryStorage([claude, codex]);
    const records = new SessionRecords(storage);
    records.remove('a1');
    records.remove('missing');
    expect(saved).toEqual([[codex]]);
    expect(records.get('a1')).toBeUndefined();
  });

  it('keeps every archived session, and of the others the 1,000 active last', () => {
    const { storage, saved } = memoryStorage();
    const records = new SessionRecords(storage);
    // Archived sessions, active before all the others, which no number of sessions sends away.
    for (let index = 0; index < 5; index += 1) {
      records.keep({ ...codex, id: `a${String(index)}`, activeAt: -10 - index, archived: true });
    }
    for (let index = 0; index <= 1_000; index += 1) {
      records.keep({ ...codex, id: `s${String(index)}`, activeAt: index });
    }
    expect(saved.at(-1)).toHaveLength(1_005);
    expect(records.get('s0')).toBeUndefined();
    expect(records.get('s1')).toBeDefined();
    expect(records.get('a4')).toBeDefined();
    // Unarchived, a session counts again; the session being kept stays, even when it was active least
    // recently.
    records.keep({ ...codex, id: 'a0', activeAt: -10 });
    expect(records.get('a0')).toBeDefined();
    expect(records.get('s1')).toBeUndefined();
    // Archiving a session leaves room for another.
    records.keep({ ...codex, id: 's2', activeAt: 2, archived: true });
    records.keep({ ...codex, id: 'late', activeAt: 2_000 });
    expect(records.get('s3')).toBeDefined();
    expect(saved.at(-1)).toHaveLength(1_005);
  });
});

describe('recordStorage', () => {
  it('keeps the sessions in sessions.json, readable by the user alone', () => {
    recordStorage(folder).save([claude, codex]);
    const file = join(folder, 'sessions.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ sessions: [claude, codex] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(recordStorage(folder).load()).toEqual([claude, codex]);
  });

  it('starts empty without a file or with one that is not JSON, and leaves out entries of another shape', () => {
    expect(recordStorage(folder).load()).toEqual([]);
    const file = join(folder, 'sessions.json');
    writeFileSync(file, '{ not json');
    expect(recordStorage(folder).load()).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        sessions: [
          codex,
          { ...claude, provider: 'other' },
          { ...claude, id: 'a4', mode: 'ask' },
          { ...claude, id: 'a5', archived: false },
          { id: 'a3' },
        ],
      }),
    );
    expect(recordStorage(folder).load()).toEqual([codex]);
  });

  it('keeps the context a session last took, and leaves out one of another shape rather than the session', () => {
    const counted: SessionRecord = { ...codex, context: { used: 25_000, size: 200_000 } };
    const unsized: SessionRecord = { ...codex, id: 'a6', context: { used: 1_000, size: null } };
    writeFileSync(
      join(folder, 'sessions.json'),
      JSON.stringify({
        sessions: [counted, unsized, { ...codex, id: 'a7', context: { used: -1, size: 0 } }],
      }),
    );
    expect(recordStorage(folder).load()).toEqual([counted, unsized, { ...codex, id: 'a7' }]);
  });
});
