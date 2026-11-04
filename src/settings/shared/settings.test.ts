import { describe, expect, it } from 'vitest';
import { preferredLanguages, settingsOf } from './settings';

describe('settings', () => {
  it('takes the settings from a value of any shape, what is not a choice giving way to the default', () => {
    expect(settingsOf({ language: 'zh-Hans', appearance: 'dark' })).toEqual({
      language: 'zh-Hans',
      appearance: 'dark',
    });
    expect(settingsOf({ language: 'fr', appearance: 7 })).toEqual({
      language: 'system',
      appearance: 'system',
    });
    expect(settingsOf(null)).toEqual({ language: 'system', appearance: 'system' });
  });

  it('stands for macOS’s preferred languages, or the one chosen', () => {
    expect(preferredLanguages('system', ['fr-FR', 'zh-CN'])).toEqual(['fr-FR', 'zh-CN']);
    expect(preferredLanguages('en', ['zh-CN'])).toEqual(['en']);
  });
});
