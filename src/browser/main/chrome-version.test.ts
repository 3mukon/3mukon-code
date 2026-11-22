import { describe, expect, it } from 'vitest';
import { MINIMUM_CHROME_VERSION, supportsChrome } from './chrome-version';

describe('supportsChrome', () => {
  it('accepts the verified minimum and later stable versions, and refuses earlier or partial ones', () => {
    expect(supportsChrome(MINIMUM_CHROME_VERSION)).toBe(true);
    expect(supportsChrome('158.0.8127.1')).toBe(false);
    expect(supportsChrome('157.0.8103.80')).toBe(false);
    expect(supportsChrome('158.0.8127.37')).toBe(true);
    expect(supportsChrome('159.0.8150.1')).toBe(true);
    expect(supportsChrome('158')).toBe(false);
  });
});
