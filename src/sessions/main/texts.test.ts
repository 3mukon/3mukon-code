import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialSessionState, type SessionState } from '../shared/session-state';
import { matchOf, textOf, textStorage } from './texts';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function data(): string {
  const made = mkdtempSync(join(tmpdir(), 'session-texts-'));
  folders.push(made);
  return made;
}

describe('textStorage', () => {
  it('keeps a text per session in a folder of its own, both readable by the user alone', async () => {
    const folder = join(data(), 'session-texts');
    const storage = textStorage(folder);
    expect(await storage.ids()).toEqual([]);
    expect(await storage.read('s1')).toBeUndefined();
    await storage.write('s1', 'Fix the build');
    await storage.write('s1', 'Fix the build\n\nDone.');
    await storage.write('s2', 'Write the docs');
    expect((await storage.ids()).sort()).toEqual(['s1', 's2']);
    expect(await storage.read('s1')).toBe('Fix the build\n\nDone.');
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, 's1.txt')).mode & 0o777).toBe(0o600);
    // Nothing but the texts stays in the folder.
    expect(readdirSync(folder).sort()).toEqual(['s1.txt', 's2.txt']);
    await storage.remove('s1');
    await storage.remove('gone');
    expect(await storage.ids()).toEqual(['s2']);
  });

  it('keeps a text only under an id that is a file name of its own', async () => {
    const storage = textStorage(join(data(), 'session-texts'));
    await expect(storage.write('../escape', 'x')).rejects.toThrow();
    await expect(storage.read('a/b')).rejects.toThrow();
  });
});

describe('textOf', () => {
  it('takes the user’s and the agent’s messages, in order, without the agent’s thinking or tools', () => {
    const state: SessionState = {
      ...initialSessionState(),
      timeline: [
        { type: 'message', id: 'm1', role: 'user', text: 'Fix the build' },
        { type: 'message', id: 'm2', role: 'thinking', text: 'Let me look.' },
        {
          type: 'tool',
          id: 't1',
          kind: 'execute',
          title: 'pnpm test',
          status: 'completed',
          output: 'ok',
          changes: [],
        },
        { type: 'message', id: 'm3', role: 'agent', text: 'The build passes now.' },
      ],
    };
    expect(textOf(state)).toBe('Fix the build\n\nThe build passes now.');
  });
});

describe('matchOf', () => {
  const text = `${'Earlier talk. '.repeat(6)}The flaky test was in the Parser module, which now retries.${' Later talk.'.repeat(8)}`;

  it('matches when the title and conversation together hold every word, whatever its case', () => {
    expect(matchOf(['parser', 'retries'], 'Fix tests', text)).not.toBeNull();
    expect(matchOf(['fix', 'parser'], 'Fix tests', text)).not.toBeNull();
    expect(matchOf(['parser', 'database'], 'Fix tests', text)).toBeNull();
    expect(matchOf([], 'Fix tests', text)).toBeNull();
  });

  it('gives the passage where the first word the conversation holds appears, cut short on either side', () => {
    expect(matchOf(['fix', 'parser'], 'Fix tests', text)?.snippet).toBe(
      '…Earlier talk. The flaky test was in the Parser module, which now retries. Later talk. Later talk. Later talk. Later talk. Late…',
    );
    // A match in the title alone gives no passage.
    expect(matchOf(['fix'], 'Fix tests', text)).toEqual({});
  });
});
