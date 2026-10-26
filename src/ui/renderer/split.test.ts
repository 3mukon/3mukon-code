import { describe, expect, it } from 'vitest';
import { clampSplit, minPaneWidth } from './split';

describe('clampSplit', () => {
  it('keeps a split that leaves both panes wide enough', () => {
    expect(clampSplit(0.5, 1000)).toBe(0.5);
    expect(clampSplit(0.3, 1000)).toBe(0.3);
  });

  it('stops each pane at the minimum width', () => {
    expect(clampSplit(0.1, 1000)).toBe(minPaneWidth / 1000);
    expect(clampSplit(0.95, 1000)).toBe(1 - minPaneWidth / 1000);
  });

  it('shares a width too narrow for two minimum panes equally', () => {
    expect(clampSplit(0.2, 2 * minPaneWidth - 1)).toBe(0.5);
    expect(clampSplit(0.8, 0)).toBe(0.5);
  });
});
