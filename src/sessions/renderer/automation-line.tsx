import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/renderer/button';
import { StatusDot, type Status } from '../../ui/renderer/status-dot';
import type { AutomationLiveState, TargetSummary } from '../shared/automation';
import { deliveryOn, sharingTag, sharingWords, targetName } from './automation-labels';

// Where the line's words name what the session uses: a character no catalog uses.
const TARGET = '\uE000';

// How the line's dot shows what the session's tools are doing with what it uses: live while they
// work, in the wait colour while they wait, pause or stop.
const phaseDots: Record<AutomationLiveState['phase'], Status> = {
  idle: 'idle',
  observing: 'live',
  acting: 'live',
  'waiting-grant': 'waiting',
  paused: 'waiting',
  stopping: 'waiting',
};

// While a session uses a tab or an application, a line above its composer's divider names it in small
// faint type, a page by its host in the ink, with how the page is shared and whether the work runs in
// the background or the foreground, or the first and how many more; Show presents what it uses, and
// Stop, while there is work to stop, stops that work and the session's turn, leaving the tabs open
// and the sign-ins in place. What could not be shown or stopped, the line says.
export function AutomationLine({
  state,
  onShow,
  onStop,
}: {
  // The session's automation as main last reported it, or nothing before it has reported any.
  state: AutomationLiveState | undefined;
  // Presents what the session uses beside it; false where it could not.
  onShow: (targets: readonly TargetSummary[]) => Promise<boolean>;
  // Stops the session's browser and computer work, and its turn; false where it could not.
  onStop: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<'show' | 'stop' | null>(null);
  const [stopping, setStopping] = useState(false);
  if (state === undefined) return null;
  const [first, ...more] = state.resources;
  if (first === undefined) return null;
  const name = targetName(first) ?? t('sessions.automation.line.blank');
  const facts =
    more.length > 0
      ? [t('sessions.automation.line.more', { count: more.length })]
      : [
          sharingTag(sharingWords(first.sharing, first.browser, first.profile ?? null), t),
          t(`sessions.automation.line.${deliveryOn(state, first.ref)}`),
        ].filter((fact) => fact !== null);
  const working =
    state.phase !== 'idle' || state.operations.some((operation) => operation.state !== 'ended');
  const act = (what: 'show' | 'stop', run: () => Promise<boolean>) => {
    setProblem(null);
    run().then(
      (done) => {
        if (!done) setProblem(what);
      },
      () => {
        setProblem(what);
      },
    );
  };
  const [before = '', after = ''] = t(`sessions.automation.line.${state.phase}`, {
    target: TARGET,
  }).split(TARGET);
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2 text-[11px] text-faint">
      <StatusDot status={phaseDots[state.phase]} />
      <span className="min-w-0 truncate">
        {before}
        <span className="font-medium text-ink">{name}</span>
        {[after, ...facts.map((fact) => ` · ${fact}`)].join('')}
      </span>
      <span role="status" className="min-w-0 truncate text-del">
        {problem === null
          ? ''
          : t(
              problem === 'show'
                ? 'sessions.automation.line.cantShow'
                : 'sessions.automation.line.cantStop',
            )}
      </span>
      <span className="flex-1" />
      <Button
        small
        label={t('sessions.automation.line.show')}
        onClick={() => {
          act('show', () => onShow(state.resources));
        }}
      />
      {working && state.phase !== 'stopping' && (
        <Button
          small
          label={t('sessions.automation.line.stop')}
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            act('stop', () =>
              onStop().finally(() => {
                setStopping(false);
              }),
            );
          }}
        />
      )}
    </div>
  );
}
