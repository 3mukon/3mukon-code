import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { SetupSnapshot } from '../../sessions/shared/automation';
import { BrowserUseSetting } from './browser-use';
import { WrongChromeFolder } from './chrome-state';

beforeAll(() => {
  initI18n(['en-US']);
  // happy-dom has no popovers, which the profile menu opens as: showing and hiding one only marks it.
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
    this.dataset.shown = 'true';
  };
  HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) {
    delete this.dataset.shown;
  };
});
afterEach(cleanup);

const snapshot = (canClear: boolean): SetupSnapshot => ({
  appProfile: { id: 'embedded-app', canClear },
  chrome: {
    installedVersion: null,
    minimumVersion: '',
    connection: 'unavailable',
    profile: null,
  },
  computer: {
    helperName: 'Automation Helper',
    accessibility: 'unknown',
    screenRecording: 'unknown',
    inputMonitoring: { required: false, state: 'unknown' },
    restartRequired: false,
  },
});
const settle = () => act(() => Promise.resolve());

describe('BrowserUseSetting', () => {
  it('clears the app’s browser’s sign-ins from the user’s click, and says it did', async () => {
    const onClearSignIns = vi.fn(() => Promise.resolve(true));
    render(<BrowserUseSetting setup={snapshot(true)} onClearSignIns={onClearSignIns} />);
    expect(screen.getByRole('region', { name: 'Browser use' })).toBeDefined();
    expect(screen.getByText('Its sign-ins, shared by every session')).toBeDefined();
    expect(onClearSignIns).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Sign-Ins' }));
    await settle();
    expect(onClearSignIns).toHaveBeenCalledOnce();
    expect(screen.getByText('Cleared')).toBeDefined();
  });

  it('says when clearing failed, and offers nothing it cannot do', async () => {
    const onClearSignIns = vi.fn(() => Promise.resolve(false));
    render(<BrowserUseSetting setup={snapshot(true)} onClearSignIns={onClearSignIns} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Sign-Ins' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe('That didn’t work.');
    cleanup();
    render(<BrowserUseSetting setup={snapshot(false)} onClearSignIns={onClearSignIns} />);
    expect(screen.getByRole('button', { name: 'Clear Sign-Ins' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.queryByText('Chrome')).toBeNull();
  });

  it('shows Chrome once installed: connected with its profile and Disconnect, or Connect, which asks which profile where it has several', async () => {
    const chromeSteps = {
      allowProfiles: vi.fn(),
      connect: vi.fn(() => Promise.resolve(true)),
      disconnect: vi.fn(() => Promise.resolve(true)),
      copyFolder: vi.fn(() => Promise.resolve()),
    };
    const chrome = (fields: Partial<SetupSnapshot['chrome']>): SetupSnapshot => ({
      ...snapshot(true),
      chrome: {
        installedVersion: '158.0.8127.37',
        minimumVersion: '158.0.8127.2',
        connection: 'disconnected',
        profile: null,
        profiles: [
          { id: 'Default', name: 'Personal' },
          { id: 'Profile 1', name: 'Work' },
        ],
        ...fields,
      },
    });
    const view = render(
      <BrowserUseSetting
        setup={chrome({})}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={chromeSteps}
      />,
    );
    expect(screen.getByText('Chrome')).toBeDefined();
    expect(screen.getAllByText('Your sign-ins, through its extension')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }));
    await settle();
    expect(chromeSteps.connect).toHaveBeenCalledExactlyOnceWith('Profile 1');
    expect(screen.queryByText(/choose the tab/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy Folder Path' })).toBeNull();
    view.rerender(
      <BrowserUseSetting
        setup={chrome({ connection: 'connecting', extensionFolder: '/tmp/synthetic-extension' })}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={chromeSteps}
      />,
    );
    expect(screen.getByText(/Load unpacked/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Folder Path' }));
    await settle();
    expect(chromeSteps.copyFolder).toHaveBeenCalledExactlyOnceWith('/tmp/synthetic-extension');
    view.rerender(
      <BrowserUseSetting
        setup={chrome({ connection: 'connected', profile: { id: 'Profile 1', name: 'Work' } })}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={chromeSteps}
      />,
    );
    expect(screen.getByText('Connected').className).toContain('text-run');
    expect(screen.getByText('Work profile, with its sign-ins')).toBeDefined();
    expect(screen.queryByText(/choose the tab/i)).toBeNull();
    view.rerender(
      <BrowserUseSetting
        setup={chrome({
          connection: 'waiting',
          profile: null,
          rememberedProfile: { id: 'Profile 1', name: 'Work' },
        })}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={chromeSteps}
      />,
    );
    expect(screen.getByText('Waiting for Chrome')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(chromeSteps.disconnect).toHaveBeenCalledExactlyOnceWith('Profile 1');
    cleanup();
    render(
      <BrowserUseSetting
        setup={chrome({ profiles: [{ id: 'Default', name: 'Personal' }] })}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={chromeSteps}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await settle();
    expect(chromeSteps.connect).toHaveBeenLastCalledWith('Default');
  });

  it('says Chrome has no profile yet instead of offering Connect, names a folder that isn’t Chrome’s, and connects a profile after access is granted', async () => {
    const empty: SetupSnapshot['chrome'] = {
      installedVersion: '158.0.8127.37',
      minimumVersion: '158.0.8127.2',
      connection: 'disconnected',
      profile: null,
      profiles: [],
    };
    const steps = {
      allowProfiles: vi
        .fn<() => Promise<SetupSnapshot['chrome'] | null>>()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new WrongChromeFolder())
        .mockResolvedValueOnce({ ...empty, profiles: [{ id: 'Default', name: 'Personal' }] }),
      connect: vi.fn(() => Promise.resolve(true)),
      disconnect: vi.fn(),
    };
    const props = { onClearSignIns: () => Promise.resolve(true), chromeSteps: steps };
    const view = render(
      <BrowserUseSetting {...props} setup={{ ...snapshot(true), chrome: empty }} />,
    );
    const connect = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' });
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.getByText('No profiles yet').className).toContain('text-wait');
    expect(
      screen.getByText('Open Chrome once to create a profile, then connect it here.'),
    ).toBeDefined();
    expect(steps.allowProfiles).not.toHaveBeenCalled();

    view.rerender(
      <BrowserUseSetting
        {...props}
        setup={{ ...snapshot(true), chrome: { ...empty, profileAccessRequired: true } }}
      />,
    );
    expect(connect().disabled).toBe(false);
    expect(screen.queryByText('No profiles yet')).toBeNull();
    fireEvent.click(connect());
    await settle();
    expect(steps.connect).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(connect());
    await settle();
    expect(steps.connect).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'That isn’t Chrome’s folder. Choose Connect again and click Open without selecting anything.',
      ),
    ).toBeDefined();

    fireEvent.click(connect());
    await settle();
    expect(steps.connect).toHaveBeenCalledExactlyOnceWith('Default');
    expect(screen.queryByText(/isn’t Chrome’s folder/)).toBeNull();
  });

  it('says which version a Chrome too old to connect needs, offering nothing, and hides a Chrome not installed unless a profile is still connected to it', async () => {
    const steps = {
      allowProfiles: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(() => Promise.resolve(true)),
    };
    render(
      <BrowserUseSetting
        setup={{
          ...snapshot(true),
          chrome: {
            installedVersion: '157.0.8103.80',
            minimumVersion: '158.0.8127.2',
            connection: 'unavailable',
            profile: null,
          },
        }}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={steps}
      />,
    );
    expect(screen.getByText('Needs version 158 or later').className).toContain('text-wait');
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    cleanup();
    render(
      <BrowserUseSetting
        setup={snapshot(true)}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={steps}
      />,
    );
    expect(screen.queryByText('Chrome')).toBeNull();
    cleanup();
    render(
      <BrowserUseSetting
        setup={{
          ...snapshot(true),
          chrome: {
            ...snapshot(true).chrome,
            connection: 'waiting',
            rememberedProfile: { id: 'Default', name: 'Personal' },
          },
        }}
        onClearSignIns={() => Promise.resolve(true)}
        chromeSteps={steps}
      />,
    );
    expect(screen.getByText('Not installed').className).toContain('text-wait');
    expect(screen.getByText('Personal profile, with its sign-ins')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(steps.disconnect).toHaveBeenCalledExactlyOnceWith('Default');
  });
});
