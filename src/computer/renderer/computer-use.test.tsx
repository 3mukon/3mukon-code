import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { ComputerSetupNotice, ComputerUseSetting, type ComputerSetup } from './computer-use';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const setup = (fields: Partial<ComputerSetup>): ComputerSetup => ({
  helperName: 'Automation Helper',
  accessibility: 'granted',
  screenRecording: 'not-granted',
  inputMonitoring: { required: false, state: 'unknown' },
  restartRequired: false,
  ...fields,
});

const steps = () => ({
  open: vi.fn(() => Promise.resolve(true)),
  restart: vi.fn(() => Promise.resolve(true)),
});
const settle = () => act(() => Promise.resolve());
const row = (name: string) => {
  const nameNode = screen.getByText(name);
  const item = nameNode.closest('div.flex.min-w-0.items-center');
  if (!(item instanceof HTMLElement)) throw new Error(`No row for ${name}`);
  return within(item);
};

describe('ComputerUseSetting', () => {
  it('says which permissions are allowed, and offers the step for each that is not', () => {
    const given = steps();
    render(<ComputerUseSetting setup={setup({})} steps={given} />);
    const group = screen.getByRole('region', { name: 'Computer use' });
    expect(group.querySelector('.border-dashed')).not.toBeNull();
    expect(group.querySelector('.divide-y')).toBeNull();
    expect(row('Accessibility').getByText('Allowed').classList.contains('text-run')).toBe(true);
    expect(row('Accessibility').queryByRole('button')).toBeNull();
    expect(row('Screen Recording').getByText('Seeing other apps’ windows')).toBeDefined();
    fireEvent.click(row('Screen Recording').getByRole('button', { name: 'Open System Settings' }));
    expect(given.open).toHaveBeenCalledWith('screen-recording');
    expect(screen.queryByText('Input Monitoring')).toBeNull();
  });

  it('shows Input Monitoring only where it is needed, a restart where a permission waits for one, and what is unavailable', () => {
    const given = steps();
    render(
      <ComputerUseSetting
        setup={setup({
          accessibility: 'restart-required',
          screenRecording: 'unavailable',
          inputMonitoring: { required: true, state: 'not-granted' },
        })}
        steps={given}
      />,
    );
    expect(
      row('Accessibility')
        .getByText('Takes effect after a restart')
        .classList.contains('text-faint'),
    ).toBe(true);
    fireEvent.click(row('Accessibility').getByRole('button', { name: 'Restart Helper' }));
    expect(given.restart).toHaveBeenCalledOnce();
    expect(row('Screen Recording').getByText('Unavailable').classList.contains('text-del')).toBe(
      true,
    );
    expect(row('Screen Recording').queryByRole('button')).toBeNull();
    expect(
      row('Input Monitoring').getByRole('button', { name: 'Open System Settings' }),
    ).toBeDefined();
  });

  it('offers the steps before the helper has reported, and says when a step did not go', async () => {
    const given = steps();
    given.open.mockResolvedValue(false);
    render(<ComputerUseSetting setup={null} steps={given} />);
    fireEvent.click(row('Accessibility').getByRole('button', { name: 'Open System Settings' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe('That didn’t work.');
  });
});

describe('ComputerSetupNotice', () => {
  it('says what computer use needs, as the session’s requests are drawn, with the step that starts it', async () => {
    const given = steps();
    render(
      <ComputerSetupNotice
        need={{ kind: 'permission', permission: 'screen-recording' }}
        steps={given}
      />,
    );
    const notice = screen.getByRole('region', { name: 'Computer use needs Screen Recording' });
    expect(notice.className).toContain('border-dashed');
    expect(notice.querySelector('.lucide-circle-alert')?.getAttribute('class')).toContain(
      'text-wait',
    );
    expect(
      screen.getByText(
        'macOS hasn’t allowed the app to see other apps’ windows. Allow it in System Settings, then ask again.',
      ).className,
    ).toContain('text-muted');
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
    expect(given.open).toHaveBeenCalledWith('screen-recording');
    cleanup();
    given.restart.mockResolvedValue(false);
    render(<ComputerSetupNotice need={{ kind: 'restart-helper' }} steps={given} />);
    expect(screen.getByText('Computer use needs the app’s helper to restart')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Restart Helper' }));
    await settle();
    expect(given.restart).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toBe('That didn’t work.');
  });
});
