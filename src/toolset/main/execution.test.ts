import { describe, expect, it } from 'vitest';
import { isJson, requestKey } from './execution';

describe('bounded request/result encoding', () => {
  it('uses stable object-key ordering without changing arrays or strings', () => {
    expect(requestKey({ b: { y: 2, x: 1 }, a: ['x', 'y'] })).toBe(
      requestKey({ a: ['x', 'y'], b: { x: 1, y: 2 } }),
    );
    expect(requestKey(['y', 'x'])).not.toBe(requestKey(['x', 'y']));
  });
  it('rejects executable values, non-finite numbers and excessive nesting', () => {
    expect(() => requestKey({ callback: () => 1 })).toThrow();
    expect(() => requestKey({ value: NaN })).toThrow();
    let value: unknown = null;
    for (let index = 0; index < 34; index++) value = [value];
    expect(() => requestKey(value)).toThrow('nesting');
  });
  it('measures result bounds in UTF-8 bytes rather than UTF-16 characters', () => {
    expect(isJson('x'.repeat(22_000))).toBe(true);
    expect(isJson('汉'.repeat(22_000))).toBe(false);
  });
});
