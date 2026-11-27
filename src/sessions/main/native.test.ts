import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { mainTranslator } from '../../i18n/main/i18n';
import type { MenuEntry, Prompts, Question } from '../../ui/shared/prompts';
import type { SessionSummary } from '../shared/sessions';
import { windowSessionsUi } from './native';

// The window's prompts, answered as the test says, each one recorded.
function fakePrompts(choice: string | null, answer = 'cancel') {
  const menus: MenuEntry[][] = [];
  const questions: Question[] = [];
  const prompts: Prompts = {
    menu: vi.fn((entries: MenuEntry[]) => {
      menus.push(entries);
      return Promise.resolve(choice);
    }),
    ask: vi.fn((question: Question) => {
      questions.push(question);
      return Promise.resolve(answer);
    }),
  };
  return { prompts, menus, questions };
}

const t = mainTranslator(['en-US']);
const window = {} as BrowserWindow;
const session: SessionSummary = {
  id: 's1',
  provider: 'codex-cli',
  sessionId: 'thread-1',
  cwd: '/Users/me/web',
  title: 'Fix the build',
  status: 'running',
  activeAt: 1,
};

describe('windowSessionsUi', () => {
  it('offers Archive, or Unarchive for an archived session, and Remove from List, in the window’s menu', async () => {
    const { prompts, menus } = fakePrompts('remove');
    const ui = windowSessionsUi(window, prompts, t);
    expect(await ui.sessionMenu(session)).toBe('remove');
    expect(await ui.sessionMenu({ ...session, archived: true })).toBe('remove');
    expect(menus).toEqual([
      [
        { id: 'archive', label: 'Archive' },
        { separator: true },
        { id: 'remove', label: 'Remove from List' },
      ],
      [
        { id: 'unarchive', label: 'Unarchive' },
        { separator: true },
        { id: 'remove', label: 'Remove from List' },
      ],
    ]);
    expect(await windowSessionsUi(window, fakePrompts(null).prompts, t).sessionMenu(session)).toBe(
      null,
    );
  });

  it('asks before yolo, before archiving a working session and before removing one, Cancel being the default answer', async () => {
    const { prompts, questions } = fakePrompts(null, 'confirm');
    const ui = windowSessionsUi(window, prompts, t);
    expect(await ui.confirmYolo()).toBe(true);
    expect(await ui.confirmArchive(session)).toBe(true);
    expect(await ui.confirmRemove(session)).toBe(true);
    expect(questions.map((question) => [question.message, question.answers])).toEqual([
      [
        expect.any(String) as string,
        [
          { id: 'confirm', label: 'Use Yolo' },
          { id: 'cancel', label: 'Cancel' },
        ],
      ],
      [
        expect.stringContaining('Fix the build') as string,
        [
          { id: 'confirm', label: 'Archive' },
          { id: 'cancel', label: 'Cancel' },
        ],
      ],
      [
        'Remove “Fix the build” from the list?',
        [
          { id: 'confirm', label: 'Remove' },
          { id: 'cancel', label: 'Cancel' },
        ],
      ],
    ]);
    for (const question of questions) {
      expect([question.defaultId, question.cancelId]).toEqual(['cancel', 'cancel']);
    }
    expect(await windowSessionsUi(window, fakePrompts(null).prompts, t).confirmYolo()).toBe(false);
  });

  it('says before yolo that a provider with one setting of its own runs without a sandbox, and that the others’ sandbox applies (ADR-0043)', async () => {
    const { prompts, questions } = fakePrompts(null, 'confirm');
    const ui = windowSessionsUi(window, prompts, t);
    await ui.confirmYolo('antigravity');
    await ui.confirmYolo('codex-cli');
    expect(questions.map((question) => question.detail)).toEqual([
      expect.stringContaining('No sandbox applies') as string,
      expect.stringContaining('Its sandbox still applies') as string,
    ]);
    expect(questions[0]?.detail).toContain('Antigravity');
  });

  it('offers Copy Image and Save Image As… in an image’s menu', async () => {
    const { prompts, menus } = fakePrompts('save');
    expect(await windowSessionsUi(window, prompts, t).imageMenu()).toBe('save');
    expect(menus).toEqual([
      [
        { id: 'copy', label: 'Copy Image' },
        { id: 'save', label: 'Save Image As…' },
      ],
    ]);
  });
});
