import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/renderer/button';
import { CircleAlert } from '../../ui/renderer/icons';
import { SettingGroup, SettingItem, SettingProblem } from '../../ui/renderer/setting-group';
import type { PermissionState, SetupSnapshot } from '../../sessions/shared/automation';
import { HELPER_NAME } from '../shared/helper';

export type Permission = 'accessibility' | 'screen-recording' | 'input-monitoring';
export type ComputerSetup = SetupSnapshot['computer'];

// The steps a user's click takes for computer use, which whoever composes the window carries out:
// opening System Settings at a permission's pane, or restarting the app's helper, so that a
// permission allowed meanwhile takes effect. Each says whether it went.
export interface ComputerSteps {
  open: (permission: Permission) => Promise<boolean>;
  restart: () => Promise<boolean>;
}

const permissionStateTones = {
  unknown: 'muted',
  granted: 'success',
  'restart-required': 'muted',
  unavailable: 'error',
} as const;

// The settings' Computer use: the macOS permissions agents need to see and operate other
// applications, Accessibility and Screen Recording, and Input Monitoring only where telling the
// user's input from the agent's needs it, and the name under which System Settings lists the app's
// helper, which holds them. A permission that is allowed says so after its name; one
// that is not offers Open System Settings only after checking, and one that takes effect only once
// the app's helper restarts offers Restart Helper. Those actions start from the user's click.
export function ComputerUseSetting({
  setup,
  steps,
}: {
  // As the helper last reported, or nothing before it has.
  setup: ComputerSetup | null;
  steps: ComputerSteps;
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
  const permissions: [Permission, PermissionState][] = [
    ['accessibility', setup?.accessibility ?? 'unknown'],
    ['screen-recording', setup?.screenRecording ?? 'unknown'],
    ...(setup?.inputMonitoring.required === true
      ? [['input-monitoring', setup.inputMonitoring.state] as [Permission, PermissionState]]
      : []),
  ];
  return (
    <SettingGroup
      label={t('computer.setting.label')}
      detail={t('computer.setting.detail', { helper: HELPER_NAME })}
    >
      {permissions.map(([permission, state]) => {
        const said = state === 'not-granted' ? null : state;
        return (
          <SettingItem
            key={permission}
            name={t(`computer.permission.${permission}.name`)}
            {...(said === null
              ? {}
              : { state: t(`computer.state.${said}`), stateTone: permissionStateTones[said] })}
            line={t(`computer.permission.${permission}.line`)}
          >
            {state === 'not-granted' && (
              <Button
                label={t('computer.open')}
                onClick={() => {
                  run(() => steps.open(permission));
                }}
              />
            )}
            {state === 'restart-required' && (
              <Button
                label={t('computer.restart')}
                onClick={() => {
                  run(steps.restart);
                }}
              />
            )}
          </SettingItem>
        );
      })}
      {failed && <SettingProblem text={t('computer.failed')} />}
    </SettingGroup>
  );
}

// A session's notice that computer use needs a permission, or the app's helper to restart, as the
// session's requests are drawn: under a dashed line, its title after a sign in the wait colour, why,
// and the step that starts it, which only the user's click takes.
export function ComputerSetupNotice({
  need,
  steps,
}: {
  need: { kind: 'permission'; permission: Permission } | { kind: 'restart-helper' };
  steps: ComputerSteps;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const step = need.kind === 'permission' ? () => steps.open(need.permission) : steps.restart;
  const title =
    need.kind === 'permission'
      ? t('computer.notice.needs', {
          permission: t(`computer.permission.${need.permission}.name`),
        })
      : t('computer.notice.restartTitle');
  return (
    <section
      aria-label={title}
      className="my-3 rounded-md border border-dashed border-line px-3 py-2"
    >
      <p className="flex min-w-0 items-center gap-2 text-ink">
        <CircleAlert className="size-3.5 shrink-0 text-wait" />
        <span className="min-w-0">{title}</span>
      </p>
      <p className="mt-0.5 text-muted">
        {need.kind === 'permission'
          ? t('computer.notice.detail', {
              missing: t(`computer.permission.${need.permission}.missing`),
              then: t('computer.notice.allowThen', { helper: HELPER_NAME }),
            })
          : t('computer.notice.restartBody')}
      </p>
      <div className="mt-2 flex items-baseline gap-3">
        <Button
          label={need.kind === 'permission' ? t('computer.open') : t('computer.restart')}
          onClick={() => {
            setFailed(false);
            step().then(
              (done) => {
                if (!done) setFailed(true);
              },
              () => {
                setFailed(true);
              },
            );
          }}
        />
        <span role="status" className="text-del">
          {failed ? t('computer.failed') : ''}
        </span>
      </div>
    </section>
  );
}
