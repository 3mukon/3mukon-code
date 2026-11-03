import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { Question } from '../../ui/shared/prompts';
import { answerPrompt, windowPrompts } from './prompts';

// A window whose page records what it is sent, and goes or navigates as the test says.
function fakeWindow(destroyed = false) {
  const contents = Object.assign(new EventEmitter(), {
    send: vi.fn<(channel: string, value: unknown) => void>(),
  });
  const window = { isDestroyed: () => destroyed, webContents: contents };
  // The id and prompt the page was last sent.
  const lastSent = () => {
    const [channel, value] = contents.send.mock.calls.at(-1) ?? [];
    expect(channel).toBe('prompts:show');
    return value as { id: number; prompt: unknown };
  };
  return {
    prompts: windowPrompts(window as unknown as BrowserWindow),
    contents: contents as unknown as WebContents,
    emitter: contents,
    lastSent,
  };
}

const remove: Question = {
  message: 'Remove “Fix the build” from the list?',
  detail: 'Its history stays with its provider.',
  answers: [
    { id: 'confirm', label: 'Remove' },
    { id: 'cancel', label: 'Cancel' },
  ],
  defaultId: 'cancel',
  cancelId: 'cancel',
};

describe('windowPrompts', () => {
  it('sends a menu to the window’s page, and resolves with the item it answers, or null', async () => {
    const { prompts, contents, lastSent } = fakeWindow();
    const entries = [{ id: 'archive', label: 'Archive' }, { separator: true as const }];
    const chosen = prompts.menu(entries);
    const { id, prompt } = lastSent();
    expect(prompt).toEqual({ kind: 'menu', entries });
    answerPrompt(contents, id, 'archive');
    expect(await chosen).toBe('archive');

    const dismissed = prompts.menu(entries);
    answerPrompt(contents, lastSent().id, null);
    expect(await dismissed).toBeNull();
  });

  it('takes only an answer the prompt offers, from the page it was sent to', async () => {
    const { prompts, contents, lastSent } = fakeWindow();
    const other = fakeWindow();
    const answer = prompts.ask(remove);
    const { id, prompt } = lastSent();
    expect(prompt).toEqual({ kind: 'question', question: remove });
    answerPrompt(contents, id, 'delete');
    answerPrompt(contents, id, null);
    answerPrompt(other.contents, id, 'confirm');
    answerPrompt(contents, id, 'confirm');
    answerPrompt(contents, id, 'cancel');
    expect(await answer).toBe('confirm');
  });

  it('cancels what the page was asked once it loads anew or goes, and asks nothing of a window that is gone', async () => {
    const { prompts, emitter } = fakeWindow();
    const menu = prompts.menu([{ id: 'archive', label: 'Archive' }]);
    const question = prompts.ask(remove);
    // A move within the page cancels nothing.
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(await menu).toBeNull();
    expect(await question).toBe('cancel');

    const later = prompts.ask(remove);
    emitter.emit('destroyed');
    expect(await later).toBe('cancel');

    const gone = fakeWindow(true);
    expect(await gone.prompts.ask(remove)).toBe('cancel');
    expect(gone.emitter.send).not.toHaveBeenCalled();
  });
});
