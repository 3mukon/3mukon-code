import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '../../ui/shared/prompts';
import type { PromptsBridge } from '../shared/bridge';
import { PromptHost } from './prompt-host';

// happy-dom has no popovers: showing and hiding one does nothing.
beforeAll(() => {
  HTMLElement.prototype.showPopover = () => undefined;
  HTMLElement.prototype.hidePopover = () => undefined;
});
afterEach(cleanup);

// The main process's side, which sends the prompts the test gives and records the answers.
function fakeBridge() {
  let send: (id: number, prompt: Prompt) => void = () => undefined;
  const bridge = {
    onPrompt: (listener) => {
      send = listener;
      return () => undefined;
    },
    answer: vi.fn<PromptsBridge['answer']>(() => Promise.resolve()),
  } satisfies PromptsBridge;
  const ask = (id: number, prompt: Prompt) => {
    act(() => {
      send(id, prompt);
    });
  };
  return { bridge, ask };
}

const menu: Prompt = {
  kind: 'menu',
  entries: [
    { id: 'archive', label: 'Archive' },
    { separator: true },
    { id: 'remove', label: 'Remove from List' },
  ],
};
const question = (message: string): Prompt => ({
  kind: 'question',
  question: {
    message,
    detail: 'Its history stays with its provider.',
    answers: [
      { id: 'confirm', label: 'Remove' },
      { id: 'cancel', label: 'Cancel' },
    ],
    defaultId: 'cancel',
    cancelId: 'cancel',
  },
});

describe('PromptHost', () => {
  it('opens a menu where the pointer asked for one, and sends back the item chosen', () => {
    const { bridge, ask } = fakeBridge();
    render(
      <>
        <button type="button">Fix the build</button>
        <PromptHost bridge={bridge} />
      </>,
    );
    const row = screen.getByRole('button', { name: 'Fix the build' });
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 200, 28));
    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    // Asked for from the keyboard, with no place of its own, it opens under its element's start.
    ask(4, menu);
    const shown = screen.getByRole('menu');
    expect([shown.style.left, shown.style.top]).toEqual(['10px', '48px']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from List' }));
    expect(bridge.answer.mock.calls).toEqual([[4, 'remove']]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a menu at the pointer’s place inside the element it was asked for on', () => {
    const { bridge, ask } = fakeBridge();
    render(
      <>
        <button type="button">Fix the build</button>
        <PromptHost bridge={bridge} />
      </>,
    );
    const row = screen.getByRole('button', { name: 'Fix the build' });
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 200, 28));
    fireEvent.contextMenu(row, { clientX: 60, clientY: 30 });
    ask(5, menu);
    const shown = screen.getByRole('menu');
    expect([shown.style.left, shown.style.top]).toEqual(['60px', '30px']);
  });

  it('asks one question at a time, in the order asked, and sends back each answer', () => {
    const { bridge, ask } = fakeBridge();
    render(<PromptHost bridge={bridge} />);
    ask(7, question('Remove “Fix the build” from the list?'));
    ask(8, question('Remove “Update the docs” from the list?'));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    screen.getByRole('alertdialog', { name: 'Remove “Update the docs” from the list?' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.answer.mock.calls).toEqual([
      [7, 'confirm'],
      [8, 'cancel'],
    ]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
