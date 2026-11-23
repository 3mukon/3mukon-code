import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/renderer/button';
import { Lock, Pointer } from '../../ui/renderer/icons';
import { StatusDot } from '../../ui/renderer/status-dot';
import type { ControlState } from '../shared/computer';

export type { ControlState } from '../shared/computer';

// The floating foreground control (ADR-0027), which the helper's panel shows just above the window an
// agent works in while that is in the foreground (ADR-0034), never taking the focus: the session and
// the application in the ink, with Stop and the shortcut that stops it from anywhere, where it is
// registered; once the user's input pauses the work, the control says the user has control, with
// Hand Back and Stop; while Secure Input pauses it, the control says why, with Stop; and when an
// application comes to the front by itself, it says so, with Stop.
export function ForegroundControlBar({
  state,
  session,
  application,
  shortcut,
  onStop,
  onHandBack,
}: {
  state: ControlState;
  // The session's name and the application's, as the window's words give them.
  session: string;
  application: string;
  // Whether ⌃⌥⌘. stops foreground control, as it does where macOS registers it.
  shortcut: boolean;
  onStop: () => Promise<boolean>;
  onHandBack: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const run = (step: () => Promise<boolean>) => {
    setFailed(false);
    step().then(
      (done) => {
        if (!done) setFailed(true);
      },
      () => {
        setFailed(true);
      },
    );
  };
  const name = t('computer.appName', { name: application });
  const stop = (
    <Button
      label={t('computer.stop')}
      disabled={state === 'stopping'}
      onClick={() => {
        run(onStop);
      }}
    />
  );
  return (
    <div className="inline-flex max-w-full min-w-0 items-center gap-2.5 rounded-[10px] border border-dashed border-menu-line paper py-1.5 pr-2 pl-3 text-[13px] whitespace-nowrap text-ink">
      {state === 'user' ? (
        <Pointer className="size-3.5 shrink-0" />
      ) : state === 'secure-input' ? (
        <Lock className="size-3.5 shrink-0 text-wait" />
      ) : (
        <StatusDot status={state === 'stopping' ? 'waiting' : 'live'} />
      )}
      <span className="min-w-0 truncate font-medium">
        {state === 'user'
          ? t('computer.control.user', { name })
          : state === 'secure-input'
            ? t('computer.control.secureInput')
            : state === 'came-forward'
              ? t('computer.control.cameForward', { name })
              : t('computer.control.using', { session, name })}
      </span>
      {(state === 'user' || state === 'came-forward') && (
        <span className="min-w-0 truncate text-faint">{session}</span>
      )}
      {state === 'user' && (
        <Button
          label={t('computer.handBack')}
          onClick={() => {
            run(onHandBack);
          }}
        />
      )}
      {stop}
      {shortcut && (state === 'acting' || state === 'stopping') && (
        <span className="shrink-0 text-[11px] text-faint">{t('computer.control.shortcut')}</span>
      )}
      <span role="status" className="shrink-0 text-[11px] text-del empty:hidden">
        {failed ? t('computer.failed') : ''}
      </span>
    </div>
  );
}
