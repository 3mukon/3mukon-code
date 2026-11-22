import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCover, isCovered, onCoversChange } from './cover';

const box = { left: 100, top: 100, right: 300, bottom: 300 };

function placed(left: number, top: number, width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => new DOMRect(left, top, width, height);
  return element;
}

const removals: (() => void)[] = [];
afterEach(() => {
  for (const remove of removals.splice(0)) remove();
});

describe('covers', () => {
  it('says whether what lies over the page meets a box, the whole window always', () => {
    expect(isCovered(box)).toBe(false);
    removals.push(addCover(placed(0, 0, 50, 50)));
    expect(isCovered(box)).toBe(false);
    removals.push(addCover(placed(250, 280, 120, 40)));
    expect(isCovered(box)).toBe(true);
    for (const remove of removals.splice(0)) remove();
    expect(isCovered(box)).toBe(false);
    removals.push(addCover('window'));
    expect(isCovered(box)).toBe(true);
  });

  it('keeps each registration apart, so that one ending leaves another in place', () => {
    const first = addCover('window');
    const second = addCover('window');
    removals.push(second);
    first();
    first();
    expect(isCovered(box)).toBe(true);
  });

  it('tells its listeners at each change, and again after the next frame', () => {
    vi.useFakeTimers();
    try {
      const heard = vi.fn();
      const stop = onCoversChange(heard);
      const remove = addCover(placed(150, 150, 10, 10));
      expect(heard).toHaveBeenCalledTimes(1);
      vi.advanceTimersToNextFrame();
      expect(heard).toHaveBeenCalledTimes(2);
      remove();
      expect(heard).toHaveBeenCalledTimes(3);
      stop();
      removals.push(addCover('window'));
      expect(heard).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
