import { describe, expect, it } from 'vitest';
import { clickWait, withGap } from './click-wait';

describe('clickWait', () => {
  it('waits 150ms before any double click', () => {
    expect(clickWait([])).toBe(150);
  });

  it('waits a margin longer than the slowest recent double click, between 100ms and 400ms', () => {
    expect(clickWait([120, 180, 140])).toBe(220);
    expect(clickWait([10, 20])).toBe(100);
    expect(clickWait([500])).toBe(400);
  });

  it('counts the last five double clicks only', () => {
    let gaps: number[] = [];
    for (const gap of [300, 110, 120, 100, 90, 130]) gaps = withGap(gaps, gap);
    expect(gaps).toEqual([110, 120, 100, 90, 130]);
    expect(clickWait(gaps)).toBe(170);
  });
});
