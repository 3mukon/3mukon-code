import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/renderer/button';
import { StatusDot, type Status } from '../../ui/renderer/status-dot';
import type { AutomationLiveState, TargetSummary } from '../shared/automation';
import { deliveryOn, sharingTag, sharingWords, targetName } from './automation-labels';

// Where a row's words name what the session uses: a character no catalog uses.
const TARGET = '';

type Phase = AutomationLiveState['phase'];

// How a row's dot shows what the session's tools are doing with its target: live while they work, in
// the wait colour while they wait, pause or stop.
const phaseDots: Record<Phase, Status> = {
  idle: 'idle',
  observing: 'live',
  acting: 'live',
  'waiting-grant': 'waiting',
  paused: 'waiting',
  stopping: 'waiting',
};

// While a session uses tabs or applications, rows above its composer's divider name each, in small
// faint type: what the session does there (Using, Waiting for your answer to use, Paused in, Stopping
// in), a page by its host in the ink, with how the page is shared and whether a panel shows it or it
// works in the background, and an application, counting once with all of its windows, with whether
// the work runs in the background or the foreground. Show, while no panel shows a row's target,
// presents it; a tab's Close closes it, ending the agent's use of it. The composer's Stop stops the
// session's work, so the rows offer none. What could not be shown or closed, they say.
export function AutomationLine({
  state,
  shown,
  onShow,
  onClose,
}: {
  // The session's automation as main last reported it, or nothing before it has reported any.
  state: AutomationLiveState | undefined;
  // Whether a panel shows a tab or an application now.
  shown: (target: TargetSummary) => boolean;
  // Presents a target beside the session, an application with its windows; false where it could not.
  onShow: (targets: readonly TargetSummary[]) => Promise<boolean>;
  // Closes a tab the session uses; false where it could not.
  onClose: (tab: TargetSummary) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<'show' | 'close' | null>(null);
  const [closing, setClosing] = useState<ReadonlySet<string>>(() => new Set());
  if (state === undefined) return null;
  const ids = new Set(state.resources.map(({ ref }) => ref.id));
  const targets = state.resources.filter(
    ({ application }) => application === undefined || !ids.has(application.id),
  );
  if (targets.length === 0) return null;
  const act = (what: 'show' | 'close', run: () => Promise<boolean>) => {
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
  const close = (tab: TargetSummary) => {
    const id = tab.ref.id;
    setClosing((now) => new Set(now).add(id));
    act('close', () =>
      onClose(tab).finally(() => {
        setClosing((now) => {
          const next = new Set(now);
          next.delete(id);
          return next;
        });
      }),
    );
  };
  return (
    <div className="mb-1.5 flex max-h-28 min-w-0 flex-col gap-1 overflow-y-auto text-[11px] text-faint">
      {targets.map((target) => {
        const members = [
          target,
          ...state.resources.filter(({ application }) => application?.id === target.ref.id),
        ];
        const phase = phaseOf(state, members);
        const name = targetName(target) ?? t('sessions.automation.line.blank');
        const tab = target.ref.kind === 'browser-tab';
        const where = tab && shown(target) ? 'panel' : deliveryOn(state, target.ref);
        const facts = [
          sharingTag(sharingWords(target.sharing, target.browser, target.profile ?? null), t),
          t(`sessions.automation.line.${where}`),
        ].filter((fact) => fact !== null);
        const [before = '', after = ''] = t(`sessions.automation.line.${phase}`, {
          target: TARGET,
        }).split(TARGET);
        return (
          <div key={target.ref.id} className="flex min-w-0 items-center gap-2">
            <StatusDot status={phaseDots[phase]} />
            <span className="min-w-0 truncate">
              {before}
              <span className="font-medium text-ink">{name}</span>
              {[after, ...facts.map((fact) => ` · ${fact}`)].join('')}
            </span>
            <span className="flex-1" />
            {!shown(target) && (
              <Button
                small
                label={t('sessions.automation.line.show')}
                spoken={t('sessions.automation.line.showNamed', { target: name })}
                onClick={() => {
                  act('show', () => onShow(members));
                }}
              />
            )}
            {tab && (
              <Button
                small
                label={t('sessions.automation.line.close')}
                spoken={t('sessions.automation.line.closeNamed', { target: name })}
                disabled={closing.has(target.ref.id)}
                onClick={() => {
                  close(target);
                }}
              />
            )}
          </div>
        );
      })}
      <span role="status" className="min-w-0 truncate text-del empty:hidden">
        {problem === null
          ? ''
          : t(
              problem === 'show'
                ? 'sessions.automation.line.cantShow'
                : 'sessions.automation.line.cantClose',
            )}
      </span>
    </div>
  );
}

// What the session does with a target, with its windows for an application: waits for the user's
// answer to use it, is paused while the user has it, stops, works with it while its tools work, or
// only holds it.
function phaseOf(state: AutomationLiveState, members: readonly TargetSummary[]): Phase {
  const ids = new Set(members.map(({ ref }) => ref.id));
  const operations = state.operations.filter(
    (operation) => ids.has(operation.target.id) && operation.state !== 'ended',
  );
  if (
    state.pendingApprovals.some((approval) => ids.has(approval.target.ref.id)) ||
    operations.some((operation) => operation.state === 'waiting')
  )
    return 'waiting-grant';
  if (state.pausedTargets?.some(({ target }) => ids.has(target.id))) return 'paused';
  if (operations.some((operation) => operation.state === 'stopping')) return 'stopping';
  if (operations.length > 0 && (state.phase === 'acting' || state.phase === 'observing'))
    return state.phase;
  return 'idle';
}
