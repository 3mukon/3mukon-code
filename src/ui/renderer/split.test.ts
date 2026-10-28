import { describe, expect, it } from 'vitest';
import { clampRatio } from './split';

describe('clampRatio', () => {
  it('keeps a ratio that leaves both parts their smallest size', () => {
    expect(clampRatio(0.5, 1000, 200)).toBe(0.5);
    expect(clampRatio(0.3, 1000, 200)).toBe(0.3);
  });

  it('stops each part at its smallest size', () => {
    expect(clampRatio(0.1, 1000, 200)).toBe(0.2);
    expect(clampRatio(0.95, 1000, 200)).toBe(0.8);
  });

  it('shares a length too short for two smallest parts equally', () => {
    expect(clampRatio(0.2, 399, 200)).toBe(0.5);
    expect(clampRatio(0.8, 0, 200)).toBe(0.5);
  });
});
