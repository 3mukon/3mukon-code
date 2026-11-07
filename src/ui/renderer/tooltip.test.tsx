import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLTIP_DELAY_MS, TooltipHost } from './tooltip';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The tooltip shown, if any.
const tip = () => document.querySelector('[data-tooltip]');
const rest = () => {
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  });
};

// Two icon buttons named in their titles, as the app's are, and a paragraph without one.
function setup(enabled = true) {
  render(
    <>
      <TooltipHost enabled={enabled} />
      <button type="button" aria-label="Next match" title="Next match">
        <svg aria-hidden="true" />
      </button>
      <button type="button" aria-label="Close" title="Close">
        x
      </button>
      <p>Plain</p>
    </>,
  );
  const next = screen.getByRole('button', { name: 'Next match' });
  const icon = next.querySelector('svg');
  if (icon === null) throw new Error('The icon is not drawn.');
  return {
    next,
    icon,
    close: screen.getByRole('button', { name: 'Close' }),
    plain: screen.getByText('Plain'),
  };
}

describe('TooltipHost', () => {
  it('shows an element’s title once the pointer rests on it, its own title set aside meanwhile, and hides it as the pointer leaves', () => {
    const { next, icon, plain } = setup();
    fireEvent.pointerOver(icon);
    expect(next.hasAttribute('title')).toBe(false);
    expect(tip()).toBeNull();
    rest();
    expect(tip()?.textContent).toBe('Next match');
    expect(tip()?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.pointerOver(plain);
    expect(tip()).toBeNull();
    expect(next.getAttribute('title')).toBe('Next match');
  });

  it('names the next element at once while moving along a row, and shows none for a pressed element until the pointer leaves it', () => {
    const { next, close, plain } = setup();
    fireEvent.pointerOver(next);
    rest();
    fireEvent.pointerOver(close);
    expect(tip()?.textContent).toBe('Close');
    expect(next.getAttribute('title')).toBe('Next match');

    fireEvent.pointerDown(close);
    expect(tip()).toBeNull();
    expect(close.getAttribute('title')).toBe('Close');
    fireEvent.pointerOver(close);
    rest();
    expect(tip()).toBeNull();
    fireEvent.pointerOver(plain);
    fireEvent.pointerOver(close);
    rest();
    expect(tip()?.textContent).toBe('Close');
  });

  it('follows a title that changes while it shows, keeping it aside', async () => {
    const { next } = setup();
    fireEvent.pointerOver(next);
    rest();
    await act(async () => {
      next.setAttribute('title', 'Copied');
      await Promise.resolve();
    });
    expect(tip()?.textContent).toBe('Copied');
    expect(next.hasAttribute('title')).toBe(false);
    fireEvent.pointerOut(next, { relatedTarget: null });
    expect(tip()).toBeNull();
    expect(next.getAttribute('title')).toBe('Copied');
  });

  it('shows the tooltip of the element the keyboard focuses, keeping its title, and hides it as the focus leaves', () => {
    const { next, close } = setup();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => {
      next.focus();
    });
    rest();
    expect(tip()?.textContent).toBe('Next match');
    expect(next.getAttribute('title')).toBe('Next match');
    fireEvent.keyDown(next, { key: 'Tab' });
    act(() => {
      close.focus();
    });
    rest();
    expect(tip()?.textContent).toBe('Close');
    act(() => {
      close.blur();
    });
    expect(tip()).toBeNull();

    // A press that focuses an element shows no tooltip for it.
    fireEvent.pointerDown(next);
    act(() => {
      next.focus();
    });
    rest();
    expect(tip()).toBeNull();
  });

  it('hides at Escape, the wheel and the window losing the focus', () => {
    const { next } = setup();
    for (const leave of [
      () => fireEvent.keyDown(next, { key: 'Escape' }),
      () => fireEvent.wheel(next),
      () => fireEvent.blur(window),
    ]) {
      fireEvent.pointerOver(next);
      rest();
      expect(tip()).not.toBeNull();
      leave();
      expect(tip()).toBeNull();
      expect(next.getAttribute('title')).toBe('Next match');
      // Off the element, so that the next pass starts afresh.
      fireEvent.pointerOver(document.body);
    }
  });

  it('shows nothing while the tooltips are off, yet keeps a hovered element’s title aside so that macOS’s own shows none either', () => {
    const { next, plain } = setup(false);
    fireEvent.pointerOver(next);
    expect(next.hasAttribute('title')).toBe(false);
    rest();
    expect(tip()).toBeNull();
    fireEvent.pointerOver(plain);
    expect(next.getAttribute('title')).toBe('Next match');
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => {
      next.focus();
    });
    rest();
    expect(tip()).toBeNull();
  });

  it('hides as its element goes', () => {
    const { rerender } = render(
      <>
        <TooltipHost enabled />
        <button type="button" title="Close">
          x
        </button>
      </>,
    );
    fireEvent.pointerOver(screen.getByRole('button'));
    rest();
    expect(tip()).not.toBeNull();
    rerender(
      <>
        <TooltipHost enabled />
      </>,
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(tip()).toBeNull();
  });
});
