import { describe, expect, it } from 'vitest';
import { mainTranslator } from './i18n';

describe('mainTranslator', () => {
  it('translates in the first English or Simplified Chinese language preferred', () => {
    expect(mainTranslator(['fr-FR', 'zh-Hans-CN', 'en-US'])('workspaces.trust.trust')).toBe('信任');
    expect(mainTranslator(['zh-Hant-TW', 'en-GB'])('workspaces.trust.trust')).toBe('Trust');
    expect(mainTranslator([])('workspaces.menu.remove')).toBe('Remove Workspace');
  });

  it('puts values in as they are, since native dialogs show plain text', () => {
    expect(mainTranslator(['en-US'])('workspaces.trust.message', { name: '<a> & b' })).toBe(
      'Do you trust the files in “<a> & b”?',
    );
  });
});
