import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPanes } from './split-panes';

// happy-dom lays nothing out, so the panes get the width a real window would give them.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderTwo(split: number, onSplitChange = vi.fn()) {
  render(
    <SplitPanes
      first={<p>one</p>}
      second={<p>two</p>}
      split={split}
      onSplitChange={onSplitChange}
      resizeLabel="Resize panes"
    />,
  );
  return onSplitChange;
}

describe('SplitPanes', () => {
  it('gives a single pane the whole width, without a divider', () => {
    render(
      <SplitPanes first={<p>one</p>} split={0.5} onSplitChange={vi.fn()} resizeLabel="Resize" />,
    );
    screen.getByText('one');
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('puts a focusable, labelled divider between two panes', () => {
    renderTwo(0.4);
    const divider = screen.getByRole('separator', { name: 'Resize panes' });
    expect(divider.getAttribute('aria-valuenow')).toBe('40');
    expect(divider.tabIndex).toBe(0);
  });

  it.each([
    ['ArrowRight', false, 0.52],
    ['ArrowLeft', false, 0.48],
    ['ArrowRight', true, 0.6],
    ['Home', false, 0.26],
    ['End', false, 0.74],
  ])('moves the divider with %s (Shift held: %s)', (key, shiftKey, expected) => {
    const onSplitChange = renderTwo(0.5);
    fireEvent.keyDown(screen.getByRole('separator'), { key, shiftKey });
    expect(onSplitChange).toHaveBeenCalledWith(expect.closeTo(expected, 5));
  });

  it('leaves other keys alone', () => {
    const onSplitChange = renderTwo(0.5);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'a' });
    expect(onSplitChange).not.toHaveBeenCalled();
  });
});
