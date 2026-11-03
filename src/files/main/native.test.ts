import { describe, expect, it, vi } from 'vitest';
import { mainTranslator } from '../../i18n/main/i18n';
import type { Prompts } from '../../ui/shared/prompts';
import { windowFilesUi } from './native';

describe('windowFilesUi', () => {
  it('asks whether to save a file’s changes before its panel closes, in macOS’s order, Save being the default answer', async () => {
    const ask = vi.fn<Prompts['ask']>(() => Promise.resolve('discard'));
    const ui = windowFilesUi({ menu: vi.fn(), ask }, mainTranslator(['en-US']));
    expect(await ui.confirmClose('notes.ts')).toBe('discard');
    expect(ask.mock.calls[0]?.[0]).toMatchObject({
      message: 'Do you want to save the changes you made to “notes.ts”?',
      answers: [
        { id: 'save', label: 'Save' },
        { id: 'cancel', label: 'Cancel' },
        { id: 'discard', label: 'Don’t Save' },
      ],
      defaultId: 'save',
      cancelId: 'cancel',
    });
    ask.mockResolvedValue('cancel');
    expect(await ui.confirmClose('notes.ts')).toBe('cancel');
  });
});
