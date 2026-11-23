import { Fragment, useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CircleAlert, Globe, Lock, Monitor, Pointer } from '../../ui/renderer/icons';
import type { ActivityIncident, TargetSummary } from '../shared/automation';
import type { MessageImage } from '../shared/events';
import {
  callState,
  sharingTag,
  sharingWords,
  targetName,
  type CallNote,
  type UseCall,
} from './automation-labels';
import { Images } from './images';
import { Entry } from './tool-call';

// Where a title's object goes in its words: a character no catalog uses.
const OBJECT = '';

// A call of the app's browser or computer tools as its session's activity shows it, in place of the
// provider's own entry for the call (ADR-0027): what it did, its words in the ink and what it did it
// to, a page's address or a control's label, in small type apart; on the call that opens a page, how
// the page is shared and whether the work runs in the background or the foreground, in dashed tags;
// and what came of it. A call refused or stopped part-way shows a sign in the wait colour. Under it,
// each on a line of its own, what happened on the way, such as a dialog the page opened being
// dismissed or an application coming to the front, then the screenshots it took, small, in a frame
// that enlarges as other images do; they are read only once the call shows, and again as it takes
// more.
export function AutomationCall({
  record,
  loadFrames,
  notice,
}: {
  record: UseCall;
  // The call's screenshots, which the activity's record names without their pixels.
  loadFrames: () => Promise<MessageImage[]>;
  // Under the call, a notice from whoever composes the page, such as the setup a refused call needs,
  // with the step that starts it.
  notice?: ReactNode;
}) {
  const { t } = useTranslation();
  const { status, note } = callState(record);
  const summary = record.target.state === 'resolved' ? record.target.summary : null;
  const attention =
    note?.key === 'refused' || note?.key === 'partial' || note?.key === 'indeterminate';
  const shared = sharingTag(
    sharingWords(record.sharing, summary?.browser, summary?.profile ?? null),
    t,
  );
  const opening = record.toolName === 'browser_open' || record.toolName === 'browser_navigate';
  const application = applicationTag(record, summary);
  const tags = opening
    ? [...(shared === null ? [] : [shared]), t(`sessions.automation.delivery.${record.delivery}`)]
    : application === null
      ? []
      : [application];
  const wanted = record.framesState === 'available' ? record.frames.length : 0;
  const [frames, setFrames] = useState<
    { count: number; images: MessageImage[] } | { count: number; failed: true } | null
  >(null);
  const load = useEffectEvent(() => loadFrames());
  useEffect(() => {
    if (wanted === 0) return;
    let current = true;
    load().then(
      (images) => {
        if (current) setFrames({ count: wanted, images });
      },
      () => {
        if (current) setFrames({ count: wanted, failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [record.callId, wanted]);
  const action = record.family === 'browser' ? record.browserAction : record.computerAction;
  const happened = new Map<string, Happening>();
  for (const incident of record.incidents) {
    const words = happening(incident, record, summary, shared, t);
    happened.set(words.key, words);
  }
  const evicted = record.framesState === 'evicted' && record.frames.length > 0;
  const icon = attention
    ? CircleAlert
    : action?.kind === 'click' || action?.kind === 'point-click'
      ? Pointer
      : record.family === 'browser'
        ? Globe
        : Monitor;
  return (
    <div className="min-w-0">
      <Entry
        icon={icon}
        kind={t(`sessions.automation.kind.${record.family}`)}
        status={status}
        attention={attention}
        title={<Phrase {...titleOf(record, summary, t)} />}
        bright={status === 'running'}
        tags={tags}
        {...(note === null ? {} : { note: noteWords(note, t) })}
      />
      {[...happened.values()].map(({ key, ...entry }) => (
        <Entry
          key={key}
          kind={t(`sessions.automation.kind.${record.family}`)}
          status="completed"
          bright={false}
          {...entry}
        />
      ))}
      {(evicted || (frames !== null && wanted > 0)) && (
        <div className="mb-1 flex min-w-0 flex-col gap-1 pl-5.5 text-faint">
          {evicted && <p>{t('sessions.automation.frames.evicted')}</p>}
          {frames !== null &&
            wanted > 0 &&
            ('failed' in frames ? (
              <p>{t('sessions.automation.frames.failed')}</p>
            ) : (
              frames.images.length > 0 && <Images images={frames.images} shot />
            ))}
        </div>
      )}
      {notice}
    </div>
  );
}

// A title's words in the ink, around its object, if it has one, in small type in the line's own
// colour.
function Phrase({ text, object }: { text: string; object?: string }) {
  const parts = text.split(OBJECT);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && object !== undefined && <span className="text-[12px]">{object}</span>}
          {part !== '' && <span className="text-ink">{part}</span>}
        </Fragment>
      ))}
    </>
  );
}

// What a call did, by the tool's own deed where the activity knows the tool, and otherwise by the
// tool's name: its words, with OBJECT where its object goes, and the object, a page's host and path
// or a control's label; an application or a window is named in the words.
function titleOf(
  record: UseCall,
  summary: TargetSummary | null,
  t: TFunction,
): { text: string; object?: string } {
  const site = summary === null ? null : targetName(summary, true);
  const named = { name: appName(summary, t) };
  switch (record.toolName) {
    case 'browser_open':
    case 'browser_snapshot':
    case 'browser_screenshot':
    case 'computer_targets':
      return { text: t(`sessions.automation.tool.${record.toolName}`) };
    case 'browser_navigate':
      return site === null
        ? { text: t('sessions.automation.tool.browser_navigateBlank') }
        : {
            text: t('sessions.automation.tool.browser_navigate', { target: OBJECT }),
            object: site,
          };
    case 'browser_close':
      return site === null
        ? { text: t('sessions.automation.tool.browser_closeBlank') }
        : { text: t('sessions.automation.tool.browser_close', { target: OBJECT }), object: site };
    case 'browser_act': {
      const action = record.family === 'browser' ? record.browserAction : undefined;
      if (action === undefined) return { text: t('sessions.automation.tool.browser_act') };
      if (action.kind !== 'scroll' && action.label !== undefined)
        return {
          text: t(`sessions.automation.action.${action.kind}Control`, { target: OBJECT }),
          object: t('sessions.automation.quoted', { label: action.label }),
        };
      return { text: t(`sessions.automation.action.${action.kind}`) };
    }
    case 'computer_act': {
      const action = record.family === 'computer' ? record.computerAction : undefined;
      if (action === undefined) return { text: t('sessions.automation.tool.computer_act', named) };
      if (action.kind === 'window')
        return { text: t(`sessions.automation.window.${action.change}`) };
      if (
        (action.kind === 'click' || action.kind === 'type' || action.kind === 'scroll') &&
        action.label !== undefined
      )
        return {
          text: t(`sessions.automation.computer.${action.kind}Control`, { target: OBJECT }),
          object: t('sessions.automation.quoted', { label: action.label }),
        };
      return { text: t(`sessions.automation.computer.${action.kind}`) };
    }
    case 'computer_select':
    case 'computer_windows':
    case 'computer_observe':
    case 'computer_release':
      return { text: t(`sessions.automation.tool.${record.toolName}`, named) };
    default:
      return summary === null
        ? { text: t('sessions.automation.tool.otherAlone', { tool: record.toolName }) }
        : {
            text: t('sessions.automation.tool.other', {
              tool: record.toolName,
              target: site ?? summary.name,
            }),
          };
  }
}

// The application a computer call worked in, as its tag names it where the call's words do not: an
// action in a window, or a look at one, by the window's application.
function applicationTag(record: UseCall, summary: TargetSummary | null): string | null {
  if (record.family !== 'computer' || summary === null) return null;
  if (record.toolName === 'computer_act') return summary.applicationName ?? summary.name;
  if (record.toolName === 'computer_observe' && summary.applicationName !== summary.name)
    return summary.applicationName ?? null;
  return null;
}

// An application or a window by its name, as the activity's words give it: quoted in Chinese.
function appName(summary: TargetSummary | null, t: TFunction): string {
  return summary === null || summary.name === ''
    ? t('sessions.automation.someApp')
    : t('sessions.automation.appName', { name: summary.name });
}

function noteWords(note: CallNote, t: TFunction): string {
  switch (note.key) {
    case 'indeterminate':
      return t(`sessions.automation.note.indeterminate.${note.reason}`);
    case 'refused':
      if (note.detail?.kind === 'denial' && note.detail.message !== '')
        return t('sessions.automation.note.denied', { message: note.detail.message });
      if (note.detail?.kind === 'sandbox')
        return t('sessions.automation.note.sandbox', {
          sandbox: t(`sessions.sandbox.${note.detail.level}`),
        });
      return t(`sessions.automation.note.refused.${note.code}`);
    default:
      return t(`sessions.automation.note.${note.key}`);
  }
}

// What happened on the way, as a line of its own under the call: its sign, its words, and what more
// there is to say, such as the page's sharing or the control that opened a window.
interface Happening {
  key: string;
  icon: typeof Globe;
  attention?: boolean;
  title: string;
  tags?: string[];
  note?: string;
}

function happening(
  incident: ActivityIncident,
  record: UseCall,
  summary: TargetSummary | null,
  shared: string | null,
  t: TFunction,
): Happening {
  switch (incident.kind) {
    case 'dialog-dismissed':
      return {
        key: 'dialog',
        icon: Globe,
        title: t('sessions.automation.incident.dialog'),
        ...(shared === null ? {} : { tags: [shared] }),
      };
    case 'target-self-activated': {
      const name =
        summary !== null && summary.ref.id === incident.target.id
          ? (targetName(summary) ?? summary.name)
          : '';
      const action = record.family === 'browser' ? record.browserAction : record.computerAction;
      const control =
        action !== undefined && 'label' in action && action.kind !== 'scroll'
          ? action.label
          : undefined;
      return {
        key: `activated-${incident.target.id}`,
        icon: CircleAlert,
        attention: true,
        title:
          name === ''
            ? t('sessions.automation.incident.activatedUnknown')
            : t('sessions.automation.incident.activated', {
                name: t('sessions.automation.appName', { name }),
              }),
        ...(incident.cause === 'popup' && control !== undefined
          ? {
              note: t('sessions.automation.incident.openedWindow', {
                control: t('sessions.automation.quoted', { label: control }),
              }),
            }
          : {}),
      };
    }
    case 'takeover':
      return { key: 'takeover', icon: Pointer, title: t('sessions.automation.incident.takeover') };
    case 'secure-input':
      return incident.enabled
        ? {
            key: 'secure-on',
            icon: Lock,
            attention: true,
            title: t('sessions.automation.incident.secureInputOn'),
          }
        : {
            key: 'secure-off',
            icon: Lock,
            title: t('sessions.automation.incident.secureInputOff'),
          };
  }
}
