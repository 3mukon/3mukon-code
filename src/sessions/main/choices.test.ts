import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RememberedChoice } from '../shared/sessions';
import { choiceStorage, RememberedChoices, type StoredChoices } from './choices';

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'choices-'));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const root = '/Users/me/3mukon-code';
const codex: RememberedChoice = {
  provider: 'codex-cli',
  gateway: null,
  model: 'gpt-6-astra',
  effort: 'medium',
  sandbox: 'read-only',
};
const claude: RememberedChoice = {
  provider: 'claude-code',
  gateway: 'work',
  model: null,
  effort: 'high',
  sandbox: 'workspace-write',
};

// A storage in memory, which records what was saved.
function memoryStorage(initial: StoredChoices = { folders: [] }) {
  const saved: StoredChoices[] = [];
  return {
    storage: { load: () => initial, save: (choices: StoredChoices) => saved.push(choices) },
    saved,
  };
}

describe('RememberedChoices', () => {
  it('keeps each folder’s last settings, the folder last used last', () => {
    const { storage, saved } = memoryStorage({ folders: [['/a', codex]] });
    const choices = new RememberedChoices(storage, root);
    choices.remember('/b', claude);
    choices.remember('/a', { ...codex, effort: 'high' });
    expect(saved.at(-1)).toEqual({
      folders: [
        ['/b', claude],
        ['/a', { ...codex, effort: 'high' }],
      ],
    });
    expect(choices.all(['claude-code', 'codex-cli'])).toEqual({
      folders: { '/a': { ...codex, effort: 'high' }, '/b': claude },
      dayRoot: root,
    });
  });

  it('keeps one set of settings for all the day folders, apart from the folders', () => {
    const { storage, saved } = memoryStorage({ folders: [['/a', codex]], dayFolders: codex });
    const choices = new RememberedChoices(storage, root);
    choices.remember(`${root}/2026-10-28`, claude);
    choices.remember(`${root}/2026-10-29`, { ...claude, effort: 'low' });
    choices.remember(root, codex);
    expect(saved.at(-1)).toEqual({
      folders: [
        ['/a', codex],
        [root, codex],
      ],
      dayFolders: { ...claude, effort: 'low' },
    });
    expect(choices.all(['claude-code', 'codex-cli']).dayFolders).toEqual({
      ...claude,
      effort: 'low',
    });
    expect(choices.all(['codex-cli'])).toEqual({
      folders: { '/a': codex, [root]: codex },
      dayRoot: root,
    });
  });

  it('leaves out the providers the app does not offer, and keeps the last 200 folders', () => {
    const { storage, saved } = memoryStorage();
    const choices = new RememberedChoices(storage, root);
    for (let index = 0; index <= 200; index += 1) choices.remember(`/f${String(index)}`, codex);
    choices.remember('/claude', claude);
    expect(saved.at(-1)?.folders).toHaveLength(200);
    expect(saved.at(-1)?.folders[0]?.[0]).toBe('/f2');
    expect(Object.keys(choices.all(['claude-code']).folders)).toEqual(['/claude']);
  });
});

describe('choiceStorage', () => {
  it('keeps the settings in session-choices.json, readable by the user alone', () => {
    choiceStorage(folder).save({ folders: [['/a', codex]], dayFolders: claude });
    const file = join(folder, 'session-choices.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      folders: [{ folder: '/a', ...codex }],
      dayFolders: claude,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(choiceStorage(folder).load()).toEqual({ folders: [['/a', codex]], dayFolders: claude });
  });

  it('starts empty without a file or with one that is not JSON, and leaves out entries of another shape', () => {
    expect(choiceStorage(folder).load()).toEqual({ folders: [] });
    const file = join(folder, 'session-choices.json');
    writeFileSync(file, '{ not json');
    expect(choiceStorage(folder).load()).toEqual({ folders: [] });
    writeFileSync(
      file,
      JSON.stringify({
        folders: [
          { folder: '/a', ...codex },
          { folder: '/b', provider: 'other' },
        ],
        dayFolders: { provider: 'other' },
      }),
    );
    expect(choiceStorage(folder).load()).toEqual({ folders: [['/a', codex]] });
  });
});
