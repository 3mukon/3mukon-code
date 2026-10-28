import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Divider } from './divider';

afterEach(cleanup);

// A split 1000 pixels wide and 600 tall, 100 pixels from the page's left and top.
const bounds = () => ({ left: 100, top: 100, width: 1000, height: 600 });

function renderDivider(direction: 'row' | 'column', ratio: number) {
  const onRatioChange = vi.fn<(ratio: number) => void>();
  render(
    <Divider
      direction={direction}
      ratio={ratio}
      onRatioChange={onRatioChange}
      bounds={bounds}
      label="Resize panels"
      style={{ left: '40%' }}
    />,
  );
  return onRatioChange;
}

describe('Divider', () => {
  it('is a focusable, labelled separator where its parent places it', () => {
    renderDivider('row', 0.4);
    const divider = screen.getByRole('separator', { name: 'Resize panels' });
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-valuenow')).toBe('40');
    expect(divider.tabIndex).toBe(0);
    expect(divider.style.left).toBe('40%');
  });

  it.each([
    ['ArrowRight', false, 0.52],
    ['ArrowLeft', false, 0.48],
    ['ArrowRight', true, 0.6],
    // Parts side by side keep at least 200 of the 1000 pixels.
    ['Home', false, 0.2],
    ['End', false, 0.8],
  ])('moves between parts side by side with %s (Shift held: %s)', (key, shiftKey, ratio) => {
    const onRatioChange = renderDivider('row', 0.5);
    fireEvent.keyDown(screen.getByRole('separator'), { key, shiftKey });
    expect(onRatioChange).toHaveBeenCalledWith(expect.closeTo(ratio, 5));
  });

  it('moves up and down between stacked parts', () => {
    const onRatioChange = renderDivider('column', 0.5);
    const divider = screen.getByRole('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    fireEvent.keyDown(divider, { key: 'ArrowDown' });
    // Stacked parts keep at least 120 of the 600 pixels.
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(onRatioChange.mock.calls).toEqual([[expect.closeTo(0.52, 5)], [0.2]]);
  });

  it('follows the pointer while it is dragged', () => {
    const onRatioChange = renderDivider('row', 0.5);
    const divider = screen.getByRole('separator');
    divider.setPointerCapture = vi.fn();
    fireEvent.pointerDown(divider, { pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 800 });
    fireEvent.pointerUp(divider);
    fireEvent.pointerMove(divider, { clientX: 300 });
    expect(onRatioChange.mock.calls).toEqual([[0.7]]);
  });

  it('leaves other keys alone', () => {
    const onRatioChange = renderDivider('row', 0.5);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'a' });
    expect(onRatioChange).not.toHaveBeenCalled();
  });
});
