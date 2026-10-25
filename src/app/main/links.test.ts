import { describe, expect, it } from 'vitest';
import { isWebUrl } from './links';

describe('isWebUrl', () => {
  it.each(['https://example.com/docs?page=2', 'http://localhost:5173/'])('accepts %s', (url) => {
    expect(isWebUrl(url)).toBe(true);
  });

  it.each([
    'file:///Applications/Calculator.app',
    'javascript:alert(1)',
    'smb://server/share',
    'x-custom-app://open?path=/tmp',
    'example.com',
    '',
  ])('rejects %j', (url) => {
    expect(isWebUrl(url)).toBe(false);
  });
});
