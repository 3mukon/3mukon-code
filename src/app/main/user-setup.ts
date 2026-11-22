import type { ChromeProfileConnection } from '../../browser/main/chrome-profile';
import { MINIMUM_CHROME_VERSION, supportsChrome } from '../../browser/main/chrome-version';
import type { HelperSetup } from '../../computer/shared/helper';
import type { Outcome, ProfileSummary, SetupSnapshot } from '../../sessions/shared/automation';
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
type ChromeSetupPort = Pick<
  ChromeProfileConnection,
  | 'profile'
  | 'rememberedProfile'
  | 'profiles'
  | 'connecting'
  | 'extensionFolder'
  | 'connect'
  | 'disconnect'
  | 'subscribe'
>;

// What the window's settings and setup notices show of browser and computer use, and the steps the
// user's click takes there: the app's browser, whose sign-ins Clear Sign-Ins clears through the
// embedded browser, and the macOS permissions, which the helper reports. Reading the settings
// returns cached facts and checks permission status asynchronously under the helper's identity.
// Only the first read waits for Chrome's version and profiles, so that a notice's Connect, which
// may be the first read since the app started, finds the profiles Chrome has.
export class UserSetup implements UserSetupBridge {
  private readonly listeners = new Set<(snapshot: SetupSnapshot) => void>();
  private chromeVersion: string | null = null;
  private checkingChrome?: Promise<void>;
  private chromeChecked = false;
  private chromeProfiles: ProfileSummary[] = [];

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
    ports.chrome?.subscribe(() => {
      this.publish();
    });
  }

  snapshot(): Promise<SetupSnapshot> {
    const known = this.current();
    const publish = () => {
      this.publish();
    };
    void this.ports.helper.check().then(publish, publish);
    this.checkingChrome ??= Promise.all([
      this.ports.installedChromeVersion(),
      this.ports.chrome?.profiles() ?? Promise.resolve([]),
    ])
      .then(([version, profiles]) => {
        const changed =
          version !== this.chromeVersion ||
          JSON.stringify(profiles) !== JSON.stringify(this.chromeProfiles);
        this.chromeVersion = version;
        this.chromeProfiles = profiles;
        if (changed) this.publish();
      })
      .catch(() => undefined)
      .finally(() => {
        this.chromeChecked = true;
        this.checkingChrome = undefined;
      });
    return this.chromeChecked
      ? Promise.resolve(known)
      : this.checkingChrome.then(() => ({ ...known, chrome: this.current().chrome }));
  }

  subscribe(listener: (snapshot: SetupSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async act(action: SetupAction): Promise<Outcome<null>> {
    switch (action.kind) {
      case 'clear-app-sign-ins':
        return this.ports.clearAppSignIns();
      case 'restart-helper': {
        const result = await this.ports.helper.restart();
        this.publish();
        return result.status === 'verified' ? verified : result;
      }
      case 'open-permission':
        try {
          await this.ports.openUrl(PERMISSION_PANES[action.permission]);
          return verified;
        } catch {
          return { status: 'refused', code: 'not-found', dispatched: false };
        }
      case 'connect-browser':
        if (this.ports.chrome) return this.ports.chrome.connect(action.profileId);
        return { status: 'refused', code: 'background-unavailable', dispatched: false };
      case 'disconnect-browser':
        if (this.ports.chrome) return this.ports.chrome.disconnect(action.profileId);
        return { status: 'refused', code: 'background-unavailable', dispatched: false };
    }
  }

  private current(): SetupSnapshot {
    const profile = this.ports.chrome?.profile() ?? null;
    const remembered = this.ports.chrome?.rememberedProfile() ?? null;
    const extensionFolder = this.ports.chrome?.extensionFolder();
    const supported = this.ports.chrome && this.chromeVersion && supportsChrome(this.chromeVersion);
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
          ? { profiles: this.chromeProfiles.map((entry) => ({ ...entry })) }
          : {}),
      },
      computer: this.ports.helper.status().permissions,
    };
  }

  private publish(): void {
    const snapshot = this.current();
    for (const listener of this.listeners) listener(snapshot);
  }
}
