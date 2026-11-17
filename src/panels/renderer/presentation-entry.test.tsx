import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { ShowOutcome } from '../shared/presentation';
import { PresentationEntry } from './presentation-entry';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

describe('PresentationEntry', () => {
  it('records what the session showed, offering Show only while none of its panels is open', () => {
    const onShow = vi.fn(() => Promise.resolve<ShowOutcome>('shown'));
    const { rerender } = render(<PresentationEntry title="Comparison" open onShow={onShow} />);
    expect(screen.getByText('Showed Comparison beside this session')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    rerender(<PresentationEntry title="Comparison" open={false} onShow={onShow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('says why a presentation could not be shown again, and nothing once it was', async () => {
    const outcomes: ShowOutcome[] = ['expired', 'unsaved-changes', 'busy', 'unavailable', 'shown'];
    const said: string[] = [];
    for (const outcome of outcomes) {
      cleanup();
      render(
        <PresentationEntry
          title="Comparison"
          open={false}
          onShow={() => Promise.resolve(outcome)}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      await act(() => Promise.resolve());
      said.push(screen.getByRole('status').textContent);
    }
    expect(said).toEqual([
      'It’s no longer available.',
      'One of its panels has unsaved changes.',
      'It’s changing; try again.',
      'It can’t be shown now.',
      '',
    ]);
  });

  it('lets a failed Show’s words go once the presentation opens, and says nothing of a later answer', async () => {
    let answer!: (outcome: ShowOutcome) => void;
    const onShow = vi
      .fn<() => Promise<ShowOutcome>>()
      .mockResolvedValueOnce('busy')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
    const { rerender } = render(
      <PresentationEntry title="Comparison" open={false} onShow={onShow} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await act(() => Promise.resolve());
    expect(screen.getByRole('status').textContent).toBe('It’s changing; try again.');
    // Its agent presents it again, and the user later closes it.
    rerender(<PresentationEntry title="Comparison" open onShow={onShow} />);
    expect(screen.getByRole('status').textContent).toBe('');
    rerender(<PresentationEntry title="Comparison" open={false} onShow={onShow} />);
    expect(screen.getByRole('status').textContent).toBe('');
    // A Show whose answer comes only after the presentation opened and closed again.
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    rerender(<PresentationEntry title="Comparison" open onShow={onShow} />);
    rerender(<PresentationEntry title="Comparison" open={false} onShow={onShow} />);
    await act(() => {
      answer('unavailable');
      return Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('takes a request that fails to reach main as unavailable', async () => {
    render(
      <PresentationEntry
        title="Comparison"
        open={false}
        onShow={() => Promise.reject(new Error('gone'))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await act(() => Promise.resolve());
    expect(screen.getByRole('status').textContent).toBe('It can’t be shown now.');
  });
});
