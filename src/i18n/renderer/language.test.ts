import { describe, expect, it } from 'vitest';
import { resolveLanguage } from './language';

describe('resolveLanguage', () => {
  it.each([
    [['en-US'], 'en'],
    [['en-GB', 'zh-CN'], 'en'],
    [['zh-CN'], 'zh-Hans'],
    [['zh-Hans-CN', 'en-US'], 'zh-Hans'],
    [['zh'], 'zh-Hans'],
    [['zh-SG'], 'zh-Hans'],
  ])('picks %j as %s', (preferred, expected) => {
    expect(resolveLanguage(preferred)).toBe(expected);
  });

  it('skips languages it does not offer, Traditional Chinese included', () => {
    expect(resolveLanguage(['fr-FR', 'zh-Hans-CN'])).toBe('zh-Hans');
    expect(resolveLanguage(['zh-TW', 'en-US'])).toBe('en');
    expect(resolveLanguage(['zh-Hant-HK', 'zh-CN'])).toBe('zh-Hans');
  });

  it('falls back to English', () => {
    expect(resolveLanguage(['ja-JP', 'de-DE'])).toBe('en');
    expect(resolveLanguage(['zh-TW'])).toBe('en');
    expect(resolveLanguage(['not a tag'])).toBe('en');
    expect(resolveLanguage([])).toBe('en');
  });
});
