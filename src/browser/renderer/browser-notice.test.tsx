import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { ProfileSummary } from '../../sessions/shared/automation';
import { BrowserSetupNotice, type BrowserSetupSteps } from './browser-notice';
import type { ChromeSetup } from './chrome-state';

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

const settle = () => act(() => Promise.resolve());
const PERSONAL = { id: 'Default', name: 'Personal' };

// Chrome as main reports it: installed and new enough, with these profiles, not connected.
function chromeOf(fields: Partial<ChromeSetup> = {}, profiles: ProfileSummary[] = [PERSONAL]) {
  return {
    installedVersion: '158.0.8127.18',
    minimumVersion: '158.0.8127.2',
    connection: 'disconnected',
    profile: null,
    profiles,
    ...fields,
  } satisfies ChromeSetup;
}

// The notice's steps over a main that reads as `read` and reports through `report`.
function steps(read: ChromeSetup = chromeOf()) {
  const receivers = new Set<(chrome: ChromeSetup) => void>();
  return {
    chrome: vi.fn(() => Promise.resolve(read)),
    watchChrome: vi.fn((receive: (chrome: ChromeSetup) => void) => {
      receivers.add(receive);
      return () => {
        receivers.delete(receive);
      };
    }),
    connectChrome: vi.fn(() => Promise.resolve(true)),
    copyFolder: vi.fn(() => Promise.resolve()),
    report: (chrome: ChromeSetup) => {
      act(() => {
        for (const receive of receivers) receive(chrome);
      });
    },
  } satisfies BrowserSetupSteps & { report: unknown };
}

describe('BrowserSetupNotice', () => {
  it('says browser use needs Chrome connected, connects its only profile and then says it is connected', async () => {
    const given = steps();
    render(<BrowserSetupNotice steps={given} />);
    const notice = screen.getByRole('region', { name: 'Browser use needs Chrome connected' });
    expect(notice.className).toContain('border-dashed');
    expect(notice.querySelector('.lucide-circle-alert')?.getAttribute('class')).toContain(
      'text-wait',
    );
    expect(
      screen.getByText('Chrome isn’t connected yet. Connect it, then ask again.'),
    ).toBeDefined();
    expect(given.chrome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await settle();
    await settle();
    expect(given.connectChrome).toHaveBeenCalledExactlyOnceWith('Default');
    given.report(chromeOf({ connection: 'connecting' }));
    expect(screen.getByText('Connecting')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    given.report(chromeOf({ connection: 'connected', profile: PERSONAL }));
    expect(screen.getByText('Connected').className).toContain('text-run');
    expect(screen.getByText('Personal profile, with its sign-ins')).toBeDefined();
    expect(screen.queryByText(/choose the tab/i)).toBeNull();
  });

  it('asks which Chrome profile where there are several, by their names', async () => {
    const given = steps(chromeOf({}, [PERSONAL, { id: 'Profile 1', name: 'Work' }]));
    render(<BrowserSetupNotice steps={given} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await settle();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }));
    await settle();
    expect(given.connectChrome).toHaveBeenCalledExactlyOnceWith('Profile 1');
  });

  it('shows Chrome’s state in place of connecting again once it was connected elsewhere', async () => {
    const given = steps(chromeOf({ connection: 'connected', profile: PERSONAL }));
    render(<BrowserSetupNotice steps={given} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await settle();
    expect(screen.getByText('Connected')).toBeDefined();
    expect(screen.getByText('Personal profile, with its sign-ins')).toBeDefined();
    expect(given.connectChrome).not.toHaveBeenCalled();
  });

  it.each([
    [chromeOf({ installedVersion: null, connection: 'unavailable' }), 'Not installed'],
    [
      chromeOf({ installedVersion: '157.0.8103.80', connection: 'unavailable' }),
      'Needs version 158 or later',
    ],
  ])('says what the app cannot do for Chrome in the wait colour', async (read, words) => {
    const given = steps(read);
    render(<BrowserSetupNotice steps={given} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await settle();
    expect(screen.getByText(words).className).toContain('text-wait');
    expect(given.connectChrome).not.toHaveBeenCalled();
  });

  it('heeds no report before the click, when main may not have checked Chrome yet', () => {
    const given = steps();
    render(<BrowserSetupNotice steps={given} />);
    given.report(chromeOf({ installedVersion: null, connection: 'unavailable', profiles: [] }));
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined();
    expect(screen.queryByText('Not installed')).toBeNull();
  });

  it('guides the extension’s first load while connecting, with its folder’s path to copy', async () => {
    const given = steps();
    render(<BrowserSetupNotice steps={given} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await settle();
    await settle();
    given.report(chromeOf({ connection: 'connecting', extensionFolder: '/data/chrome-extension' }));
    expect(screen.getByText(/Turn on Developer mode and choose Load unpacked/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Folder Path' }));
    await settle();
    expect(given.copyFolder).toHaveBeenCalledExactlyOnceWith('/data/chrome-extension');
    expect(screen.getByText('Copied')).toBeDefined();
    given.report(chromeOf({ connection: 'connected', profile: PERSONAL }));
    expect(screen.queryByRole('button', { name: 'Copy Folder Path' })).toBeNull();
  });

  it('says a connection that did not go didn’t work, and offers Connect again', async () => {
    const given = steps();
    given.connectChrome.mockResolvedValueOnce(false);
    render(<BrowserSetupNotice steps={given} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await settle();
    await settle();
    given.report(chromeOf());
    expect(screen.getByRole('status').textContent).toBe('That didn’t work.');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined();
  });
});
