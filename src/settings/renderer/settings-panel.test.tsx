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
  it('chooses the language, each named in itself, the appearance, each from System and two more, and whether tooltips show', () => {
    const onChange = vi.fn<(change: Partial<AppSettings>) => void>();
    render(
      <SettingsPanel
        settings={{
          language: 'zh-Hans',
          appearance: 'system',
          tooltips: false,
          sidebarHidden: false,
        }}
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
    const tooltips = screen.getByRole('radiogroup', { name: 'Tooltips' });
    expect(
      within(tooltips)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Off', 'On']);
    within(tooltips).getByRole('radio', { name: 'Off', checked: true });
    fireEvent.click(within(language).getByRole('radio', { name: 'English' }));
    fireEvent.click(within(appearance).getByRole('radio', { name: 'Dark' }));
    fireEvent.click(within(tooltips).getByRole('radio', { name: 'On' }));
    expect(onChange.mock.calls).toEqual([
      [{ language: 'en' }],
      [{ appearance: 'dark' }],
      [{ tooltips: true }],
    ]);
  });
});
