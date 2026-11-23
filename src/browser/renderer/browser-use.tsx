import { useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/renderer/button';
import { Menu } from '../../ui/renderer/menu';
import { SettingGroup, SettingItem, SettingProblem } from '../../ui/renderer/setting-group';
import type { ProfileSummary, SetupSnapshot } from '../../sessions/shared/automation';
import { ChromeInstallHelp } from './chrome-install-help';
import { chromeProfile, chromeState, type ChromeSetup } from './chrome-state';

// Chrome setup connects a profile and guides the first local extension load.
export interface ChromeSteps {
  allowProfiles: () => Promise<ChromeSetup | null>;
  connect: (profileId: string) => Promise<boolean>;
  disconnect: (profileId: string) => Promise<boolean>;
  copyFolder?: (path: string) => Promise<void>;
}

// The Browser use settings let the user clear the app's shared sign-ins or manage the Chrome
// connection.
export function BrowserUseSetting({
  setup,
  onClearSignIns,
  chromeSteps,
}: {
  // As main last reported, or nothing before it has.
  setup: SetupSnapshot | null;
  // Clears the app's browser's sign-ins; whether it did.
  onClearSignIns: () => Promise<boolean>;
  chromeSteps?: ChromeSteps;
}) {
  const { t } = useTranslation();
  const [cleared, setCleared] = useState<'done' | 'failed' | null>(null);
  const clear = () => {
    setCleared(null);
    onClearSignIns().then(
      (done) => {
        setCleared(done ? 'done' : 'failed');
      },
      () => {
        setCleared('failed');
      },
    );
  };
  return (
    <SettingGroup label={t('browser.setting.label')} detail={t('browser.setting.detail')}>
      <SettingItem
        name={t('browser.app.name')}
        {...(cleared === 'done' ? { state: t('browser.app.cleared') } : {})}
        line={t('browser.app.line')}
      >
        <Button
          label={t('browser.app.clear')}
          disabled={setup !== null && !setup.appProfile.canClear}
          onClick={clear}
        />
      </SettingItem>
      {cleared === 'failed' && <SettingProblem text={t('browser.failed')} />}
      {setup !== null &&
        (setup.chrome.installedVersion !== null || chromeProfile(setup.chrome) !== null) &&
        chromeSteps && <ChromeSetting chrome={setup.chrome} steps={chromeSteps} />}
    </SettingGroup>
  );
}

// Chrome pairs one profile from the app. Disconnect is available even when
// Chrome is closed and the saved profile is waiting for it to return.
function ChromeSetting({ chrome, steps }: { chrome: SetupSnapshot['chrome']; steps: ChromeSteps }) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [choosing, setChoosing] = useState<{
    at: { x: number; y: number };
    profiles: readonly ProfileSummary[];
  } | null>(null);
  const run = (step: () => Promise<boolean>) => {
    setFailed(false);
    setRunning(true);
    step().then(
      (done) => {
        setRunning(false);
        if (!done) setFailed(true);
      },
      () => {
        setRunning(false);
        setFailed(true);
      },
    );
  };
  const profile = chromeProfile(chrome);
  const state = chromeState(chrome, t);
  const connect = (chosen: ProfileSummary) => {
    run(() => steps.connect(chosen.id));
  };
  const chooseProfile = (available: ChromeSetup, at: { x: number; y: number }) => {
    if (chromeState(available, t) !== null) return;
    const profiles = available.profiles ?? [];
    const [only] = profiles;
    if (profiles.length === 1 && only !== undefined) connect(only);
    else if (profiles.length > 1) setChoosing({ at, profiles });
  };
  const askProfile = (event: MouseEvent<HTMLButtonElement>) => {
    const { left, bottom } = event.currentTarget.getBoundingClientRect();
    const at = { x: left, y: bottom + 4 };
    if (!chrome.profileAccessRequired) {
      chooseProfile(chrome, at);
      return;
    }
    setFailed(false);
    setRunning(true);
    void steps.allowProfiles().then(
      (available) => {
        setRunning(false);
        if (available !== null) chooseProfile(available, at);
      },
      () => {
        setRunning(false);
        setFailed(true);
      },
    );
  };
  return (
    <>
      <SettingItem
        name={t('sessions.automation.sharing.chrome')}
        {...(state === null ? {} : { state: state.state, stateTone: state.tone })}
        line={
          profile === null
            ? t('browser.chrome.line')
            : t('browser.chrome.profileLine', { profile: profile.name })
        }
      >
        {profile !== null ? (
          <Button
            label={t('browser.chrome.disconnect')}
            disabled={running}
            onClick={() => {
              run(() => steps.disconnect(profile.id));
            }}
          />
        ) : (
          state === null && (
            <Button
              label={t('browser.chrome.connect')}
              disabled={running || (!chrome.profileAccessRequired && !chrome.profiles?.length)}
              onClick={askProfile}
            />
          )
        )}
      </SettingItem>
      {chrome.extensionFolder && steps.copyFolder && (
        <ChromeInstallHelp
          folder={chrome.extensionFolder}
          copyFolder={steps.copyFolder}
          className="px-2.5 pb-2 text-[11px]"
        />
      )}
      {failed && <SettingProblem text={t('browser.failed')} />}
      {choosing !== null && (
        <Menu
          entries={choosing.profiles.map((entry) => ({ id: entry.id, label: entry.name }))}
          at={choosing.at}
          onClose={(chosen) => {
            setChoosing(null);
            const picked = choosing.profiles.find((entry) => entry.id === chosen);
            if (picked !== undefined) connect(picked);
          }}
        />
      )}
    </>
  );
}
