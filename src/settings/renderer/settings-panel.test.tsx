import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { AppSettings } from '../shared/settings';
import { SettingsPanel } from './settings-panel';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

describe('SettingsPanel', () => {
  it('chooses the language, each named in itself, and the appearance, each from System and two more', () => {
    const onChange = vi.fn<(change: Partial<AppSettings>) => void>();
    render(
      <SettingsPanel
        settings={{ language: 'zh-Hans', appearance: 'system' }}
        onChange={onChange}
      />,
    );
    const language = screen.getByRole('radiogroup', { name: 'Language' });
    expect(
      within(language)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['System', 'English', '简体中文']);
    within(language).getByRole('radio', { name: '简体中文', checked: true });
    const appearance = screen.getByRole('radiogroup', { name: 'Appearance' });
    within(appearance).getByRole('radio', { name: 'System', checked: true });
    fireEvent.click(within(language).getByRole('radio', { name: 'English' }));
    fireEvent.click(within(appearance).getByRole('radio', { name: 'Dark' }));
    expect(onChange.mock.calls).toEqual([[{ language: 'en' }], [{ appearance: 'dark' }]]);
  });
});
