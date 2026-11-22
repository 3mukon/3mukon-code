import type {
  AutomationCallRecord,
  AutomationLiveState,
  BrowserKind,
  Delivery,
  FailureCode,
  Outcome,
  ProfileSummary,
  RefusalDetail,
  Sharing,
  TargetRef,
  TargetSummary,
} from '../shared/automation';
import type { TFunction } from 'i18next';
import type { ToolStatus } from '../shared/events';

// A call of the app's browser or computer tools, as a session's activity shows it.
export type UseCall = Extract<AutomationCallRecord, { family: 'browser' | 'computer' }>;

// Where a target is, in a few words: a page by its host, or for a call by its host and path, and an
// application or a window by its name; nothing for a tab that has loaded no page.
export function targetName(summary: TargetSummary, withPath = false): string | null {
  if (summary.address !== undefined) {
    const place = placeOf(summary.address, withPath);
    if (place !== null) return place;
  }
  return summary.name === '' ? null : summary.name;
}

function placeOf(address: string, withPath: boolean): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (!withPath) return url.host;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.host}${path}`;
}

// How a page is shared, as its tag names it: with no sign-ins, with the app's own, or in Chrome with
// the profile it uses; nothing for an application's windows, which have no sharing.
export type SharingWords = { key: 'none' | 'app' } | { key: 'chrome'; profile: string | null };

export function sharingWords(
  sharing: Sharing | null | undefined,
  browser?: BrowserKind,
  profile?: ProfileSummary | null,
): SharingWords | null {
  if (sharing === 'none' || sharing === 'app') return { key: sharing };
  if (sharing === 'global' && browser === 'chrome') {
    return { key: browser, profile: profile?.name ?? null };
  }
  return null;
}

// A page's sharing in the words of its tag: No sharing, App sign-ins, or the browser with its profile.
export function sharingTag(words: SharingWords | null, t: TFunction): string | null {
  if (words === null) return null;
  switch (words.key) {
    case 'none':
    case 'app':
      return t(`sessions.automation.sharing.${words.key}`);
    case 'chrome':
      return words.profile === null
        ? t('sessions.automation.sharing.chrome')
        : t('sessions.automation.sharing.chromeProfile', { profile: words.profile });
  }
}

// Whether a session works on a target in the foreground, with the keyboard and pointer, or in the
// background, as its operations on the target say.
export function deliveryOn(state: AutomationLiveState, ref: TargetRef): Delivery {
  return state.operations.some(
    (operation) =>
      operation.target.id === ref.id &&
      operation.state !== 'ended' &&
      operation.kind === 'application-foreground',
  )
    ? 'foreground'
    : 'background';
}

// What came of a call beyond its state, in words after its title, where there is more to say than
// done or running.
export type CallNote =
  | { key: 'notChecked' | 'cancelled' | 'partial' | 'waitingApproval' }
  | {
      key: 'indeterminate';
      reason: Extract<Outcome, { status: 'indeterminate' }>['reason'];
    }
  | { key: 'refused'; code: FailureCode; detail?: RefusalDetail };

// A call's state as the activity's icons show it, and what came of it: an effect that was checked is
// done; one sent without a check says so; one stopped part-way, or whose end is unknown, may have
// happened, which the activity says, as it says why a call was refused.
export function callState(record: UseCall): { status: ToolStatus; note: CallNote | null } {
  const { outcome } = record;
  if (outcome === null) {
    if (record.phase === 'dispatched') return { status: 'running', note: null };
    if (record.phase === 'settled') return { status: 'completed', note: null };
    const waiting = record.approval !== null && record.approval.answer === null;
    return { status: 'pending', note: waiting ? { key: 'waitingApproval' } : null };
  }
  switch (outcome.status) {
    case 'verified':
      return { status: 'completed', note: null };
    case 'dispatched':
      return { status: 'completed', note: { key: 'notChecked' } };
    case 'cancelled-before-dispatch':
      return { status: 'completed', note: { key: 'cancelled' } };
    case 'partial':
      return { status: 'failed', note: { key: 'partial' } };
    case 'indeterminate':
      return { status: 'failed', note: { key: 'indeterminate', reason: outcome.reason } };
    case 'refused':
      return {
        status: 'failed',
        note: {
          key: 'refused',
          code: outcome.code,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        },
      };
  }
}
