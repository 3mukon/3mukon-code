import { describe, expect, it, vi } from 'vitest';
import type { HelperSetup, HelperStatus } from '../../computer/shared/helper';
import type { Outcome, SetupSnapshot } from '../../sessions/shared/automation';
import { UserSetup } from './user-setup';

function status(
  fields: Partial<HelperStatus['permissions']>,
  connection: HelperStatus['connection'] = 'idle',
): HelperStatus {
  return {
    generation: null,
    checkedAt: null,
    connection,
    permissions: {
      helperName: 'Automation Helper',
      accessibility: 'unknown',
      screenRecording: 'unknown',
      inputMonitoring: { required: false, state: 'unknown' },
      restartRequired: false,
      ...fields,
    },
  };
}

function setup(installedChromeVersion: () => Promise<string | null> = () => Promise.resolve(null)) {
  let current = status({});
  const restart = vi.fn(() =>
    Promise.resolve<Outcome<HelperStatus>>({ status: 'verified', value: current }),
  );
  const helper = {
    status: () => current,
    check: vi.fn(() => {
      current = status({ accessibility: 'granted', screenRecording: 'not-granted' }, 'ready');
      return Promise.resolve<Outcome<HelperStatus>>({ status: 'verified', value: current });
    }),
    restart: (): Promise<Outcome<HelperStatus>> => restart(),
    request: vi.fn(() =>
      Promise.resolve<Outcome<{ prompted: boolean }>>({
        status: 'verified',
        value: { prompted: false },
      }),
    ),
  } satisfies HelperSetup;
  const clearAppSignIns = vi.fn(() =>
    Promise.resolve<Outcome<null>>({ status: 'verified', value: null }),
  );
  const openUrl = vi.fn(() => Promise.resolve());
  const host = new UserSetup({
    appProfileId: 'embedded-app',
    installedChromeVersion,
    clearAppSignIns,
    helper,
    openUrl,
  });
  return { host, helper, restart, clearAppSignIns, openUrl };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('UserSetup', () => {
  it('returns cached facts and automatically checks permissions on each settings read', async () => {
    const { host, helper, restart, openUrl } = setup();
    const heard: SetupSnapshot[] = [];
    host.subscribe((snapshot) => heard.push(snapshot));
    const first = await host.snapshot();
    expect(first.computer.accessibility).toBe('unknown');
    expect(first.appProfile).toEqual({ id: 'embedded-app', canClear: true });
    expect(first.chrome.connection).toBe('unavailable');
    await settle();
    expect(helper.check).toHaveBeenCalledOnce();
    expect(heard.at(-1)?.computer).toMatchObject({
      accessibility: 'granted',
      screenRecording: 'not-granted',
    });
    await host.snapshot();
    await settle();
    expect(helper.check).toHaveBeenCalledTimes(2);
    expect(heard).toHaveLength(2);
    expect(restart).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('takes only the steps it can: clearing the sign-ins, restarting the helper, opening a permission’s pane', async () => {
    const { host, helper, restart, clearAppSignIns, openUrl } = setup();
    expect(await host.act({ kind: 'clear-app-sign-ins' })).toEqual({
      status: 'verified',
      value: null,
    });
    expect(clearAppSignIns).toHaveBeenCalledOnce();
    const heard: SetupSnapshot[] = [];
    host.subscribe((snapshot) => heard.push(snapshot));
    expect(await host.act({ kind: 'restart-helper' })).toEqual({ status: 'verified', value: null });
    expect(restart).toHaveBeenCalledOnce();
    expect(heard).toHaveLength(1);
    expect(await host.act({ kind: 'open-permission', permission: 'screen-recording' })).toEqual({
      status: 'verified',
      value: null,
    });
    expect(openUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(helper.request).toHaveBeenCalledExactlyOnceWith('screen-recording');
    expect(helper.request.mock.invocationCallOrder[0]).toBeLessThan(
      openUrl.mock.invocationCallOrder[0] ?? 0,
    );
    // macOS's own prompt leads to the pane, which would cover it.
    helper.request.mockResolvedValueOnce({ status: 'verified', value: { prompted: true } });
    expect(
      (await host.act({ kind: 'open-permission', permission: 'screen-recording' })).status,
    ).toBe('verified');
    expect(openUrl).toHaveBeenCalledOnce();
    openUrl.mockRejectedValueOnce(new Error('no handler'));
    expect((await host.act({ kind: 'open-permission', permission: 'accessibility' })).status).toBe(
      'refused',
    );
    // A helper that cannot start leaves the user the pane.
    helper.request.mockResolvedValueOnce({
      status: 'refused',
      code: 'setup-required',
      dispatched: false,
    });
    expect((await host.act({ kind: 'open-permission', permission: 'accessibility' })).status).toBe(
      'verified',
    );
    expect(openUrl).toHaveBeenLastCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
    expect(await host.act({ kind: 'connect-browser', browser: 'chrome', profileId: 'p' })).toEqual({
      status: 'refused',
      code: 'background-unavailable',
      dispatched: false,
    });
  });

  it('answers the first reads with Chrome’s versions once checked, and later ones from the cache while it publishes what changed', async () => {
    const reading = Promise.withResolvers<string | null>();
    const installedChromeVersion = vi.fn(() => reading.promise);
    const { host, openUrl } = setup(installedChromeVersion);
    const heard: SetupSnapshot[] = [];
    host.subscribe((snapshot) => heard.push(snapshot));

    const both = Promise.all([host.snapshot(), host.snapshot()]);
    expect(installedChromeVersion).toHaveBeenCalledOnce();
    reading.resolve('157.0.8103.80');
    const [first, concurrent] = await both;
    expect(first.chrome).toMatchObject({
      installedVersion: '157.0.8103.80',
      minimumVersion: '158.0.8127.2',
      connection: 'unavailable',
    });
    expect(concurrent.chrome).toEqual(first.chrome);

    const updating = Promise.withResolvers<string | null>();
    installedChromeVersion.mockReturnValueOnce(updating.promise);
    expect((await host.snapshot()).chrome.installedVersion).toBe('157.0.8103.80');
    updating.resolve('158.0.8127.18');
    await settle();
    expect(heard.at(-1)?.chrome.installedVersion).toBe('158.0.8127.18');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('gives the first read since the app started Chrome’s profiles, as a notice’s Connect needs', async () => {
    const pending = () => new Promise<Outcome<HelperStatus>>(() => undefined);
    const host = new UserSetup({
      appProfileId: 'embedded-app',
      installedChromeVersion: () => Promise.resolve('158.0.8127.18'),
      chrome: {
        profile: () => null,
        rememberedProfile: () => null,
        profiles: () => Promise.resolve([{ id: 'Default', name: 'Personal' }]),
        connecting: () => false,
        extensionFolder: () => undefined,
        connect: () => Promise.resolve({ status: 'verified', value: null }),
        disconnect: () => Promise.resolve({ status: 'verified', value: null }),
        subscribe: () => () => undefined,
      },
      clearAppSignIns: () => Promise.resolve({ status: 'verified', value: null }),
      helper: {
        status: () => status({}),
        check: pending,
        restart: pending,
        request: () => Promise.resolve({ status: 'verified', value: { prompted: false } }),
      },
      openUrl: () => Promise.resolve(),
    });
    expect((await host.snapshot()).chrome).toMatchObject({
      installedVersion: '158.0.8127.18',
      connection: 'disconnected',
      profiles: [{ id: 'Default', name: 'Personal' }],
    });
  });

  it('passes on a restart the helper refused', async () => {
    const { host, restart } = setup();
    restart.mockResolvedValueOnce({
      status: 'refused',
      code: 'connection-lost',
      dispatched: false,
    });
    expect(await host.act({ kind: 'restart-helper' })).toEqual({
      status: 'refused',
      code: 'connection-lost',
      dispatched: false,
    });
  });
});
