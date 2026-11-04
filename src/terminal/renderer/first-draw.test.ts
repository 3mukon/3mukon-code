import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_DRAW_LIMIT_MS, FirstDraw, SETTLE_MS } from './first-draw';

describe('FirstDraw', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the terminal once its first output has rested, and only once', () => {
    const show = vi.fn();
    const draw = new FirstDraw(show);
    draw.open();
    draw.output();
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
    draw.output();
    draw.now();
    vi.advanceTimersByTime(FIRST_DRAW_LIMIT_MS);
    expect(show).toHaveBeenCalledOnce();
  });

  it('waits again while output follows, as when a prompt comes in two writes', () => {
    const show = vi.fn();
    const draw = new FirstDraw(show);
    draw.open();
    draw.output();
    vi.advanceTimersByTime(SETTLE_MS - 5);
    draw.output();
    vi.advanceTimersByTime(SETTLE_MS - 5);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5);
    expect(show).toHaveBeenCalledOnce();
  });

  it('shows the terminal at the limit, for a program that prints nothing or never rests', () => {
    const silent = vi.fn();
    new FirstDraw(silent).open();
    vi.advanceTimersByTime(FIRST_DRAW_LIMIT_MS - 1);
    expect(silent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(silent).toHaveBeenCalledOnce();

    const busy = vi.fn();
    const draw = new FirstDraw(busy);
    draw.open();
    for (let elapsed = 0; elapsed < FIRST_DRAW_LIMIT_MS; elapsed += SETTLE_MS / 2) {
      draw.output();
      vi.advanceTimersByTime(SETTLE_MS / 2);
    }
    expect(busy).toHaveBeenCalledOnce();
  });

  it('shows the terminal at once when its program ends, and never once it has gone', () => {
    const ended = vi.fn();
    const draw = new FirstDraw(ended);
    draw.open();
    draw.now();
    expect(ended).toHaveBeenCalledOnce();

    const gone = vi.fn();
    const closed = new FirstDraw(gone);
    closed.open();
    closed.output();
    closed.dispose();
    vi.advanceTimersByTime(FIRST_DRAW_LIMIT_MS);
    expect(gone).not.toHaveBeenCalled();
  });
});
