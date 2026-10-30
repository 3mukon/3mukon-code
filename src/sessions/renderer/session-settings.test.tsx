import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { SessionSettings, type Setting } from './session-settings';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function settings(onModel = vi.fn()): Setting[] {
  return [
    { label: 'Provider', summary: true, text: 'Claude Code' },
    { label: 'Gateway', summary: false, text: 'work' },
    {
      label: 'Model',
      summary: true,
      value: '',
      options: [
        { value: '', label: 'Opus' },
        { value: 'sonnet', label: 'Sonnet' },
      ],
      onChange: onModel,
    },
    {
      label: 'Permission mode',
      summary: true,
      value: 'auto',
      options: [{ value: 'auto', label: 'Auto' }],
      onChange: vi.fn(),
    },
  ];
}

// The width the row of settings takes, and the width it has; the test environment lays out nothing.
function widths(row: number, area: number) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(row);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(area);
}

describe('SessionSettings', () => {
  it('shows the settings in a row while it has room for them', () => {
    widths(300, 600);
    render(<SessionSettings settings={settings()} />);
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDefined();
    expect(screen.getByText('Claude Code')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('holds them in one dropdown otherwise, whose button names those in the summary', () => {
    widths(600, 300);
    const onModel = vi.fn();
    render(<SessionSettings settings={settings(onModel)} />);
    const button = screen.getByRole('button', {
      name: 'Session settings: Claude Code · Opus · Auto',
    });
    expect(button.textContent).toBe('Claude Code · Opus · Auto');
    const dropdown = document.getElementById(button.getAttribute('popovertarget') ?? '');
    if (dropdown === null) throw new Error('no dropdown');
    expect(dropdown.getAttribute('popover')).toBe('auto');
    // A display of the dropdown's own would show it while closed.
    expect(dropdown.className).not.toMatch(/(^|\s)(grid|flex|block|inline[-\w]*)(\s|$)/);
    const inside = within(dropdown);
    expect(inside.getByText('Provider')).toBeDefined();
    expect(inside.getByText('Claude Code')).toBeDefined();
    expect(inside.getByText('work')).toBeDefined();
    fireEvent.change(inside.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'sonnet' },
    });
    expect(onModel.mock.calls).toEqual([['sonnet']]);
    // The row stays laid out to be measured, out of reach.
    const row = screen
      .getAllByRole('combobox', { name: 'Model' })
      .find((select) => !dropdown.contains(select));
    expect(row?.closest('[inert]')).not.toBeNull();
  });
});
