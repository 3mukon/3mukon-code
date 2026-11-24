import type {
  ChromeFolderPicker,
  ChromeProfileConnection,
  ChromeProfileList,
} from '../../browser/main/chrome-profile';
import { MINIMUM_CHROME_VERSION, supportsChrome } from '../../browser/main/chrome-version';
import type { HelperSetup } from '../../computer/shared/helper';
import type { Outcome, SetupSnapshot } from '../../sessions/shared/automation';
import type { SetupAction, UserSetupBridge } from '../../toolset/shared/automation';

type Permission = Extract<SetupAction, { kind: 'open-permission' }>['permission'];

// System Settings' pane for each permission computer use needs.
const PERMISSION_PANES: Record<Permission, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

const verified: Outcome<null> = { status: 'verified', value: null };
const noProfiles: ChromeProfileList = { status: 'read', profiles: [] };
const chromeUnavailable: Outcome<null> = {
  status: 'refused',
  code: 'background-unavailable',
  dispatched: false,
};
type ChromeSetupPort = Pick<
  ChromeProfileConnection,
  | 'profile'
  | 'rememberedProfile'
  | 'profiles'
  | 'allowProfileAccess'
  | 'connecting'
  | 'extensionFolder'
  | 'connect'
  | 'disconnect'
  | 'subscribe'
>;

// What the window's settings and setup notices show of browser and computer use, and the steps the
// user's click takes there: the app's browser, whose sign-ins Clear Sign-Ins clears through the
// embedded browser, and the macOS permissions, which the helper reports. A permission check opens
// no System Settings but usually starts a helper, whose every start compares its bundle with the
// packaged one and checks its signature, so the permissions are checked only as the app starts and
// at each read, which Settings makes as it opens and as its window regains the focus, as it does
// when the user comes back from System Settings; never on a timer. The first settings or notice
// read waits for Chrome's version and profiles; later reads return cached facts. Each read
// publishes what its permission check finds.
export class UserSetup implements UserSetupBridge {
  private readonly listeners = new Set<(snapshot: SetupSnapshot) => void>();
  private readonly stopWatchingChrome: (() => void) | undefined;
  private checkingPermissions = false;
  private lastPublished?: string;
  private closed = false;
  private chromeVersion: string | null = null;
  private checkingChrome?: Promise<ChromeProfileList>;
  private authorizingChrome = false;
  private chromeChecked = false;
  private chromeProfiles: ChromeProfileList = noProfiles;

  constructor(
    private readonly ports: {
      appProfileId: string;
      installedChromeVersion: () => Promise<string | null>;
      chrome?: ChromeSetupPort;
      clearAppSignIns: () => Promise<Outcome<null>>;
      helper: HelperSetup;
      openUrl: (url: string) => Promise<void>;
    },
  ) {
    this.stopWatchingChrome = ports.chrome?.subscribe(() => {
      this.publish();
    });
  }

  // The check that lets Settings, opened later, tell an unchecked permission from a missing one.
  start(): void {
    this.refreshPermissions();
  }

  close(): void {
    this.closed = true;
    this.stopWatchingChrome?.();
    this.listeners.clear();
  }

  snapshot(): Promise<SetupSnapshot> {
    const known = this.current();
    if (this.closed) return Promise.resolve(known);
    this.refreshPermissions();
    const checkingChrome = this.refreshChrome();
    return this.chromeChecked ? Promise.resolve(known) : checkingChrome.then(() => this.current());
  }

  private refreshPermissions(): void {
    if (this.closed || this.checkingPermissions) return;
    this.checkingPermissions = true;
    const settled = () => {
      this.checkingPermissions = false;
      this.publish();
    };
    void this.ports.helper.check({ transient: true }).then(settled, settled);
  }

  private refreshChrome(): Promise<ChromeProfileList> {
    this.checkingChrome ??= Promise.all([
      this.ports.installedChromeVersion(),
      this.ports.chrome?.profiles() ?? Promise.resolve(noProfiles),
    ])
      .then(([version, profiles]) => {
        this.chromeVersion = version;
        this.chromeProfiles = profiles;
        this.publish();
        return profiles;
      })
      .catch(() => this.chromeProfiles)
      .finally(() => {
        this.chromeChecked = true;
        this.checkingChrome = undefined;
      });
    return this.checkingChrome;
  }

  subscribe(listener: (snapshot: SetupSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async act(action: SetupAction, pickChromeFolder?: ChromeFolderPicker): Promise<Outcome<null>> {
    switch (action.kind) {
      case 'clear-app-sign-ins':
        return this.ports.clearAppSignIns();
      case 'restart-helper': {
        const result = await this.ports.helper.restart();
        this.publish();
        return result.status === 'verified' ? verified : result;
      }
      case 'open-permission': {
        // macOS asks in a prompt of its own, whose button opens the pane with the helper listed. The
        // pane would cover it, so it opens here only where no prompt shows.
        const asked = await this.ports.helper.request(action.permission);
        if (asked.status === 'verified' && asked.value.prompted) return verified;
        try {
          await this.ports.openUrl(PERMISSION_PANES[action.permission]);
          return verified;
        } catch {
          return { status: 'refused', code: 'not-found', dispatched: false };
        }
      }
      case 'allow-chrome-profiles':
        return this.allowChromeProfiles(pickChromeFolder);
      case 'connect-browser':
        if (this.ports.chrome) return this.ports.chrome.connect(action.profileId);
        return chromeUnavailable;
      case 'disconnect-browser':
        if (this.ports.chrome) return this.ports.chrome.disconnect(action.profileId);
        return chromeUnavailable;
    }
  }

  private async allowChromeProfiles(pick?: ChromeFolderPicker): Promise<Outcome<null>> {
    const chrome = this.ports.chrome;
    const closed = () => this.closed;
    if (!chrome || !pick || closed()) return chromeUnavailable;
    if (this.authorizingChrome) return { status: 'refused', code: 'busy', dispatched: false };
    this.authorizingChrome = true;
    try {
      const before = await this.refreshChrome();
      if (closed()) return chromeUnavailable;
      if (before.status === 'read') return verified;
      if (before.status !== 'access-required') return chromeUnavailable;
      const selected = await chrome.allowProfileAccess(pick);
      if (selected.status !== 'verified') return selected;
      // Wait for a read that may have started behind the sheet, then read with the new access.
      await this.checkingChrome;
      if (closed()) return chromeUnavailable;
      return (await this.refreshChrome()).status === 'read' ? verified : chromeUnavailable;
    } catch {
      return chromeUnavailable;
    } finally {
      this.authorizingChrome = false;
    }
  }

  private current(): SetupSnapshot {
    const profile = this.ports.chrome?.profile() ?? null;
    const remembered = this.ports.chrome?.rememberedProfile() ?? null;
    const extensionFolder = this.ports.chrome?.extensionFolder();
    const supported = this.ports.chrome && this.chromeVersion && supportsChrome(this.chromeVersion);
    const profiles = this.chromeProfiles;
    return {
      appProfile: { id: this.ports.appProfileId, canClear: true },
      chrome: {
        installedVersion: this.chromeVersion,
        minimumVersion: MINIMUM_CHROME_VERSION,
        connection: profile
          ? 'connected'
          : remembered
            ? 'waiting'
            : this.ports.chrome?.connecting()
              ? 'connecting'
              : supported
                ? 'disconnected'
                : 'unavailable',
        profile,
        ...(remembered ? { rememberedProfile: remembered } : {}),
        ...(extensionFolder ? { extensionFolder } : {}),
        ...(this.ports.chrome
          ? {
              profiles:
                profiles.status === 'read' ? profiles.profiles.map((entry) => ({ ...entry })) : [],
              ...(profiles.status === 'access-required' && {
                profileAccessRequired: true as const,
              }),
            }
          : {}),
      },
      computer: this.ports.helper.status().permissions,
    };
  }

  private publish(): void {
    if (this.closed) return;
    const snapshot = this.current();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastPublished) return;
    this.lastPublished = serialized;
    for (const listener of this.listeners) listener(snapshot);
  }
}
