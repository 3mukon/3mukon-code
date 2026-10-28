import { describe, expect, it } from 'vitest';
import { isAppPage, isWebUrl } from './links';

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

describe('isAppPage', () => {
  const built = 'file:///Users/me/3mukon-code/out/renderer/index.html';
  const dev = 'http://localhost:5173/';

  it.each([
    [built, built],
    [`${built}#panel`, built],
    ['http://localhost:5173/index.html', dev],
  ])('takes %s for the app’s page %s', (url, page) => {
    expect(isAppPage(url, page)).toBe(true);
  });

  it.each([
    ['file:///Users/me/Downloads/page.html', built],
    ['https://example.com/', built],
    ['http://localhost:5174/', dev],
    ['file:///Users/me/3mukon-code/out/renderer/index.html', dev],
    ['about:blank', built],
    ['', built],
  ])('refuses %j for the app’s page %s', (url, page) => {
    expect(isAppPage(url, page)).toBe(false);
  });
});
