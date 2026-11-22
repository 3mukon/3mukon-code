import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProfileSummary } from '../../sessions/shared/automation';
import { Button } from '../../ui/renderer/button';
import { CircleAlert } from '../../ui/renderer/icons';
import { Menu } from '../../ui/renderer/menu';
import { ChromeInstallHelp } from './chrome-install-help';
import { chromeProfile, chromeState, type ChromeSetup } from './chrome-state';

export interface BrowserSetupSteps {
  // Chrome's setup as main reports it, read when the user clicks Connect.
  chrome: () => Promise<ChromeSetup>;
  // Each later report of it, until the returned function is called.
  watchChrome: (receive: (chrome: ChromeSetup) => void) => () => void;
  connectChrome: (profileId: string) => Promise<boolean>;
  copyFolder?: (path: string) => Promise<void>;
}

// The tones of Chrome's state, as Settings' items have them.
const toneColors = {
  muted: 'text-muted',
  success: 'text-run',
  error: 'text-del',
  attention: 'text-wait',
} as const;

// A session's notice that browser use needs Chrome connected. Connect starts the setup Settings
// starts, connecting the only profile or the one chosen from a menu of their names; from that
// click on, Chrome's state as main reports it takes the button's place once it has one, as
// Connected with its profile when it is done, or when Chrome was connected elsewhere in the meantime.
export function BrowserSetupNotice({ steps }: { steps: BrowserSetupSteps }) {
  const { t } = useTranslation();
  // Chrome's setup as read at the user's click and as main reports it after that read. A report
  // before it may come before main has checked Chrome since the app started, and would mislead.
  const [chrome, setChrome] = useState<ChromeSetup | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [choosing, setChoosing] = useState<{
    at: { x: number; y: number };
    profiles: readonly ProfileSummary[];
  } | null>(null);
  const read = useRef(false);
  const { watchChrome } = steps;
  useEffect(
    () =>
      watchChrome((next) => {
        if (read.current) setChrome(next);
      }),
    [watchChrome],
  );
  const connect = (id: string) => {
    setRunning(true);
    steps.connectChrome(id).then(
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
  const start = (event: MouseEvent<HTMLButtonElement>) => {
    const { left, bottom } = event.currentTarget.getBoundingClientRect();
    setFailed(false);
    setRunning(true);
    steps.chrome().then(
      (known) => {
        read.current = true;
        setRunning(false);
        setChrome(known);
        if (chromeState(known, t) !== null) return;
        const profiles = known.profiles ?? [];
        const [only] = profiles;
        if (profiles.length === 1 && only !== undefined) connect(only.id);
        else if (profiles.length > 1) setChoosing({ at: { x: left, y: bottom + 4 }, profiles });
        else setFailed(true);
      },
      () => {
        setRunning(false);
        setFailed(true);
      },
    );
  };
  const title = t('browser.notice.connectTitle');
  const state = chrome === null ? null : chromeState(chrome, t);
  const profile = chrome === null ? null : chromeProfile(chrome);
  return (
    <section
      aria-label={title}
      className="my-3 rounded-md border border-dashed border-line px-3 py-2"
    >
      <p className="flex min-w-0 items-center gap-2 text-ink">
        <CircleAlert className="size-3.5 shrink-0 text-wait" />
        <span className="min-w-0">{title}</span>
      </p>
      <p className="mt-0.5 text-muted">{t('browser.notice.connectDetail')}</p>
      <div className="mt-2 flex min-w-0 items-baseline gap-3">
        {state === null ? (
          <Button label={t('browser.chrome.connect')} disabled={running} onClick={start} />
        ) : (
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className={toneColors[state.tone]}>{state.state}</span>
            {profile !== null && (
              <span className="min-w-0 truncate text-faint">
                {t('browser.chrome.profileLine', { profile: profile.name })}
              </span>
            )}
          </p>
        )}
        <span role="status" className="min-w-0 text-del">
          {failed ? t('browser.failed') : ''}
        </span>
      </div>
      {chrome?.connection === 'connecting' && chrome.extensionFolder && steps.copyFolder && (
        <ChromeInstallHelp
          folder={chrome.extensionFolder}
          copyFolder={steps.copyFolder}
          className="mt-2"
        />
      )}
      {choosing !== null && (
        <Menu
          entries={choosing.profiles.map((entry) => ({ id: entry.id, label: entry.name }))}
          at={choosing.at}
          onClose={(chosen) => {
            const picked = choosing.profiles.find((entry) => entry.id === chosen);
            setChoosing(null);
            if (picked !== undefined) connect(picked.id);
          }}
        />
      )}
    </section>
  );
}
