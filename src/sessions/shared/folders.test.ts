import { describe, expect, it } from 'vitest';
import { choiceIn, isDayFolder, withChoice } from './folders';
import type { FolderChoices, RememberedChoice } from './sessions';

const root = '/Users/me/3mukon-code';
const codex: RememberedChoice = {
  provider: 'codex-cli',
  gateway: null,
  model: 'gpt-6-astra',
  effort: 'high',
  sandbox: 'read-only',
};

describe('day folders', () => {
  it('knows a day’s folder from any other', () => {
    expect(isDayFolder(root, '/Users/me/3mukon-code/2026-10-28')).toBe(true);
    for (const path of [
      '/Users/me/3mukon-code',
      '/Users/me/3mukon-code/2026-10-28/src',
      '/Users/me/3mukon-code/../2026-10-28',
      '/Users/me/3mukon-code/notes',
      '/Users/me/3mukon-code-2026-10-28',
      '/Users/other/3mukon-code/2026-10-28',
    ]) {
      expect(isDayFolder(root, path)).toBe(false);
    }
  });

  it('gives and replaces a folder’s settings, and one set for all the day folders', () => {
    const empty: FolderChoices = { folders: {}, dayRoot: root };
    const kept = withChoice(withChoice(empty, '/work', codex), `${root}/2026-10-28`, {
      ...codex,
      effort: 'low',
    });
    expect(kept).toEqual({
      folders: { '/work': codex },
      dayRoot: root,
      dayFolders: { ...codex, effort: 'low' },
    });
    expect(choiceIn(kept, '/work')).toEqual(codex);
    expect(choiceIn(kept, `${root}/2026-10-29`)).toEqual({ ...codex, effort: 'low' });
    expect(choiceIn(kept, root)).toBeUndefined();
    expect(choiceIn(empty, `${root}/2026-10-29`)).toBeUndefined();
  });
});
