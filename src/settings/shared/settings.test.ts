import { describe, expect, it } from 'vitest';
import { defaultSettings, preferredLanguages, sameSettings, settingsOf } from './settings';

describe('settings', () => {
  it('takes the settings from a value of any shape, what is not a choice giving way to the default', () => {
    expect(
      settingsOf({ language: 'zh-Hans', appearance: 'dark', tooltips: true, sidebarHidden: true }),
    ).toEqual({
      language: 'zh-Hans',
      appearance: 'dark',
      tooltips: true,
      sidebarHidden: true,
    });
    expect(
      settingsOf({ language: 'fr', appearance: 7, tooltips: 'yes', sidebarHidden: 'yes' }),
    ).toEqual({
      language: 'system',
      appearance: 'system',
      tooltips: false,
      sidebarHidden: false,
    });
    expect(settingsOf(null)).toEqual({
      language: 'system',
      appearance: 'system',
      tooltips: false,
      sidebarHidden: false,
    });
  });

  it('starts with the tooltips off and the sidebar shown, and tells a change in any setting', () => {
    expect(defaultSettings.tooltips).toBe(false);
    expect(defaultSettings.sidebarHidden).toBe(false);
    expect(sameSettings(defaultSettings, { ...defaultSettings })).toBe(true);
    expect(sameSettings(defaultSettings, { ...defaultSettings, tooltips: true })).toBe(false);
    expect(sameSettings(defaultSettings, { ...defaultSettings, sidebarHidden: true })).toBe(false);
    expect(sameSettings(defaultSettings, { ...defaultSettings, appearance: 'dark' })).toBe(false);
  });

  it('stands for macOS’s preferred languages, or the one chosen', () => {
    expect(preferredLanguages('system', ['fr-FR', 'zh-CN'])).toEqual(['fr-FR', 'zh-CN']);
    expect(preferredLanguages('en', ['zh-CN'])).toEqual(['en']);
  });
});
