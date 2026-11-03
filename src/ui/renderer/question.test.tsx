import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '../shared/prompts';
import { QuestionDialog } from './question';

afterEach(cleanup);

const close: Question = {
  message: 'Do you want to save the changes you made to “notes.ts”?',
  detail: 'Your changes will be lost if you don’t save them.',
  answers: [
    { id: 'save', label: 'Save' },
    { id: 'cancel', label: 'Cancel' },
    { id: 'discard', label: 'Don’t Save' },
  ],
  defaultId: 'save',
  cancelId: 'cancel',
};

describe('QuestionDialog', () => {
  it('asks over the window as an alert of the window’s paper, with the focus on the default answer, drawn in ink', () => {
    render(<QuestionDialog question={close} onAnswer={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: close.message });
    expect(dialog).toHaveProperty('open', true);
    expect(dialog.getAttribute('aria-describedby')).toBe(
      screen.getByText(close.detail).getAttribute('id'),
    );
    expect(dialog.className.split(' ')).toEqual(
      expect.arrayContaining(['paper', 'border-dashed', 'border-menu-line']),
    );
    // The first answer shows at the right and any beyond the second apart at the left, as macOS lays
    // out a sheet's buttons.
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Save', 'Cancel', 'Don’t Save']);
    expect(buttons[0]?.parentElement?.className).toContain('flex-row-reverse');
    expect(buttons[2]?.className).toContain('mr-auto');
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0]?.className).toContain('bg-ink');
    expect(buttons[1]?.className).not.toContain('bg-ink');
  });

  it('gives the answer clicked, once', () => {
    const onAnswer = vi.fn();
    render(<QuestionDialog question={close} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Don’t Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onAnswer.mock.calls).toEqual([['discard']]);
  });

  it('gives the cancel answer with Escape, and when the dialog closes without an answer', () => {
    const escaped = vi.fn();
    const { unmount } = render(<QuestionDialog question={close} onAnswer={escaped} />);
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(screen.getByRole('alertdialog'), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(escaped.mock.calls).toEqual([['cancel']]);
    unmount();

    const closed = vi.fn();
    render(<QuestionDialog question={close} onAnswer={closed} />);
    fireEvent(screen.getByRole('alertdialog'), new Event('close'));
    expect(closed.mock.calls).toEqual([['cancel']]);
  });
});
