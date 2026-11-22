import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { imageUrl } from '../../sessions/shared/images';
import { ageOf, useNow } from '../../ui/renderer/age';
import { Button } from '../../ui/renderer/button';
import { Pointer } from '../../ui/renderer/icons';
import { StatusDot } from '../../ui/renderer/status-dot';
import type { ComputerBridge } from '../shared/computer';
import { useComputerPreview, type ComputerPreview } from './use-computer-preview';

// What the window's session does with its application, as its automation says: whether it holds the
// application, whether the agent acts in it now or is stopping, and whether the user has taken it.
export interface ApplicationUse {
  held: boolean;
  acting: boolean;
  stopping: boolean;
  userHas: boolean;
}

export const NO_APPLICATION_USE: ApplicationUse = {
  held: false,
  acting: false,
  stopping: false,
  userHas: false,
};

// Another application's window in a panel of its own (ADR-0027), whose header the app module gives
// the application's name, the session and whether the work runs in the background or the foreground:
// a line saying it is a preview that takes no input, and how old its frame is, with Switch to, which
// brings the application forward; the window's latest frame, faded as a preview, in a frame; while the
// first frame comes, Loading preview…; until Screen Recording is allowed, the step that allows it; a
// window that cannot be taken keeps its last frame, or shows its name and why. While the agent acts in
// the application, a chip under the frame names the session, with Stop; while the user has control
// of it, the chip says so, with Hand Back. The chip's strip stays while the session holds it.
export function ComputerPreviewPanel({
  preview,
  name,
  session,
  use,
  onSwitch,
  onStop,
  onHandBack,
  onAllow,
}: {
  preview: ComputerPreview;
  // The application's name, as the window's words give it.
  name: string;
  // The name of the session that owns the window.
  session: string;
  use: ApplicationUse;
  // Brings the application forward, as Switch to asks; whether it did.
  onSwitch: () => Promise<boolean>;
  onStop: () => Promise<boolean>;
  onHandBack: () => Promise<boolean>;
  // Opens System Settings at Screen Recording; whether it did.
  onAllow: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const now = useNow(preview.frame !== null);
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
  const quoted = t('computer.appName', { name });
  const needsPermission = preview.unavailable === 'permission-required';
  const chip = use.userHas ? 'user' : use.acting ? 'acting' : null;
  const strip = use.held || use.userHas;
  let page: ReactNode;
  if (needsPermission) {
    page = (
      <Paper>
        <p className="mb-2.5 font-semibold text-ink">
          {t('computer.preview.needsScreenRecording', { name: quoted })}
        </p>
        <Button
          label={t('computer.open')}
          onClick={() => {
            run(onAllow);
          }}
        />
      </Paper>
    );
  } else if (preview.frame !== null) {
    page = (
      <img
        src={imageUrl(preview.frame.image)}
        alt={t('computer.preview.alt', { name })}
        draggable={false}
        className="absolute inset-0 size-full object-contain object-top saturate-60"
      />
    );
  } else if (preview.unavailable !== null) {
    page = (
      <Paper>
        <p className="text-ink">{name}</p>
        <p className="text-faint">{unavailableWords(preview.unavailable, quoted, t)}</p>
      </Paper>
    );
  } else {
    page = (
      <Paper>
        <p className="text-faint">{t('computer.preview.loading')}</p>
      </Paper>
    );
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2 px-3 pb-2 text-[12px]">
        <span className="min-w-0 truncate text-muted">
          {[
            t('computer.preview.label'),
            ...(preview.frame === null || needsPermission
              ? []
              : [ageWords(now - preview.frame.capturedAt, t)]),
          ].join(' · ')}
        </span>
        <span role="status" className="shrink-0 text-[11px] text-del empty:hidden">
          {failed ? t('computer.failed') : ''}
        </span>
        <span className="flex-1" />
        <Button
          label={t('computer.preview.switch', { name: quoted })}
          onClick={() => {
            run(onSwitch);
          }}
        />
      </div>
      <div
        className={`relative mx-3 min-h-0 flex-1 overflow-hidden rounded-md border border-line paper-well ${strip ? '' : 'mb-3'}`}
      >
        {page}
      </div>
      {strip && (
        <div className="flex h-11 shrink-0 items-center px-3">
          {chip !== null && (
            <div className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-dashed border-menu-line paper py-[5px] pr-1.5 pl-2.5 text-[12px] text-ink">
              {chip === 'user' ? (
                <Pointer className="size-3.5 shrink-0" />
              ) : (
                <StatusDot status="live" />
              )}
              <span className="min-w-0 truncate">
                {chip === 'user'
                  ? t('computer.preview.control', { name: quoted })
                  : t('computer.preview.acting', { session, name: quoted })}
              </span>
              {chip === 'user' ? (
                <Button
                  label={t('computer.handBack')}
                  onClick={() => {
                    run(onHandBack);
                  }}
                />
              ) : (
                <Button
                  label={t('computer.stop')}
                  disabled={use.stopping}
                  onClick={() => {
                    run(onStop);
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A window's panel as the app composes it: its preview, asked of main while the panel shows, and its
// commands, Switch to and Hand Back, through the same presentation.
export function ComputerPreviewView({
  port,
  owner,
  presentation,
  target,
  ...shown
}: {
  port: ComputerBridge;
  owner: string;
  presentation: string;
  target: string;
  name: string;
  session: string;
  use: ApplicationUse;
  onStop: () => Promise<boolean>;
  onAllow: () => Promise<boolean>;
}) {
  const preview = useComputerPreview(port, owner, presentation, target);
  const command = (sent: 'reveal' | 'hand-back') =>
    port
      .command(owner, presentation, target, sent)
      .then((outcome) => outcome.status === 'verified');
  return (
    <ComputerPreviewPanel
      preview={preview}
      {...shown}
      onSwitch={() => command('reveal')}
      onHandBack={() => command('hand-back')}
    />
  );
}

// How old a frame is, in the preview's words.
function ageWords(milliseconds: number, t: TFunction): string {
  const { unit, count } = ageOf(milliseconds);
  return t(`computer.preview.${unit}`, { count });
}

function unavailableWords(
  reason: Exclude<ComputerPreview['unavailable'], null>,
  quoted: string,
  t: TFunction,
): string {
  switch (reason) {
    case 'application-quit':
      return t('computer.preview.quit', { name: quoted });
    case 'connection-lost':
      return t('computer.preview.connectionLost');
    default:
      return t('computer.preview.cannotShow');
  }
}

// The well's paper in the window's place, with what it says in the middle.
function Paper({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center paper px-6 text-center text-[12px]">
      {children}
    </div>
  );
}
