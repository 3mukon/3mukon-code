import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  ApprovalRecord,
  GrantEndRecord,
  HostApproval,
  OperationKind,
  TargetSummary,
} from '../../sessions/shared/automation';
import type { ApprovalAnswer } from '../../sessions/shared/events';
import { targetName } from '../../sessions/renderer/automation-labels';
import { Button } from '../../ui/renderer/button';
import { ShieldCheck, ShieldOff } from '../../ui/renderer/icons';
import { AnswerBlock } from './requests';

// An operation's approval that the app asks for its own tools, waiting in the session's activity
// (ADR-0027): what the agent wants to work on, as a question in the window's language; under it, what
// that means, how long each answer lasts, and whether the target may come to the front by itself; and
// the approvals' own answers and keys, a denial's message reaching the agent.
export function HostApprovalBlock({
  request,
  agent,
  onAnswer,
  focusKey,
}: {
  request: HostApproval;
  // The provider's name, as the session's words give it.
  agent: string;
  onAnswer?: (answer: ApprovalAnswer) => Promise<void>;
  focusKey?: number;
}) {
  const { t } = useTranslation();
  const { heading, detail, activation } = operationWords(
    request.target,
    request.operation.kind,
    request.operation.targetMayActivate,
    agent,
    t,
  );
  return (
    <AnswerBlock
      heading={heading}
      details={
        <>
          <p className="mt-0.5 text-muted">{detail}</p>
          <p className="text-muted">{t('approvals.host.scope', { agent })}</p>
          {activation !== null && <p className="text-muted">{activation}</p>}
        </>
      }
      canAllowForSession
      denyByDefault={false}
      denialMessage
      {...(onAnswer === undefined ? {} : { onAnswer })}
      {...(focusKey === undefined ? {} : { focusKey })}
    />
  );
}

// How an answered approval's grant stands: in force, ended as its record says, or none, as for a
// denial or an approval that was never answered.
export type GrantStanding = 'active' | GrantEndRecord | null;

// An answered approval, as the session's activity keeps it, on a line of its own before the call that
// asked: the question, then how it was answered, a denial with the message it sent, and once its grant
// has ended, when; a grant still in force has End at the line's right, which ends it at once.
export function AnsweredHostApproval({
  approval,
  grant,
  agent,
  onEnd,
}: {
  approval: ApprovalRecord;
  grant: GrantStanding;
  agent: string;
  // Ends the grant; false where it could not.
  onEnd?: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [ending, setEnding] = useState(false);
  const [failed, setFailed] = useState(false);
  const { answer, request } = approval;
  if (answer === null) return null;
  const { heading } = operationWords(
    request.target,
    request.operation.kind,
    request.operation.targetMayActivate,
    agent,
    t,
  );
  const outcome = t(`approvals.outcome.${answer.decision}`);
  const note =
    answer.decision === 'deny'
      ? answer.message === undefined || answer.message === ''
        ? outcome
        : `${outcome} · ${t('approvals.message', { message: answer.message })}`
      : grant !== null && grant !== 'active'
        ? `${outcome} · ${t(`approvals.host.ended.${grant.reason}`, { agent })}`
        : outcome;
  const Icon = answer.decision === 'deny' ? ShieldOff : ShieldCheck;
  const look =
    answer.decision === 'deny' ? 'text-del' : grant === 'active' ? 'text-run' : 'text-faint';
  return (
    <p className="my-0.5 flex min-w-0 items-center gap-2">
      <Icon className={`size-3.5 shrink-0 ${look}`} />
      <span className="sr-only">
        {t('sessions.tool.named', { kind: t('approvals.kind.approval') })}
      </span>
      <span className="min-w-0 truncate text-ink">{heading}</span>
      <span className="shrink-0 text-faint">{note}</span>
      {failed && (
        <span role="status" className="shrink-0 text-del">
          {t('approvals.host.endFailed')}
        </span>
      )}
      {grant === 'active' && onEnd !== undefined && (
        <Button
          small
          label={t('approvals.host.end')}
          spoken={t('approvals.host.endNamed', { question: heading })}
          disabled={ending}
          onClick={() => {
            setEnding(true);
            setFailed(false);
            onEnd().then(
              (done) => {
                setEnding(false);
                if (!done) setFailed(true);
              },
              () => {
                setEnding(false);
                setFailed(true);
              },
            );
          }}
        />
      )}
    </p>
  );
}

// What an operation's approval says: its heading, by the kind of operation and its target, a page by
// its host and an application by its name; what that means; and, where the target may come to the
// front by itself, so.
function operationWords(
  target: TargetSummary,
  kind: OperationKind,
  mayActivate: boolean,
  agent: string,
  t: TFunction,
): { heading: string; detail: string; activation: string | null } {
  if (kind === 'browser-tab') {
    const site = targetName(target);
    const chrome = target.sharing === 'global';
    const where = chrome ? 'chrome' : 'app';
    return {
      heading:
        site === null
          ? t(`approvals.host.heading.${where}Blank`)
          : t(`approvals.host.heading.${where}`, { site }),
      detail: chrome
        ? target.profile === undefined
          ? t('approvals.host.detail.chromeAnyProfile', { agent })
          : t('approvals.host.detail.chrome', { agent, profile: target.profile.name })
        : t('approvals.host.detail.app', { agent }),
      activation: mayActivate ? t('approvals.host.mayActivate.browser') : null,
    };
  }
  const name = target.applicationName ?? target.name;
  const app =
    name === '' ? t('sessions.automation.someApp') : t('sessions.automation.appName', { name });
  const words = {
    'application-background': 'background',
    'application-foreground': 'foreground',
    'system-dialog': 'dialog',
  } as const;
  const which = words[kind];
  return {
    heading: t(`approvals.host.heading.${which}`, { app }),
    detail: t(`approvals.host.detail.${which}`, { agent, app }),
    activation: mayActivate ? t('approvals.host.mayActivate.app', { app }) : null,
  };
}
