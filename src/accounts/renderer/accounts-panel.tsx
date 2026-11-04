import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderId } from '../../sessions/shared/events';
import { Gauge } from '../../ui/renderer/icons';
import {
  NEARLY_USED,
  type AccountsBridge,
  type ProviderAccount,
  type ResetOutcome,
  type SignIn,
  type UsageProblem,
  type UsageWindow,
} from '../shared/accounts';
import { readWhen, resetTime, share, windowName } from './format';
import { useNow } from './use-now';

// How often the panel's times, such as how long ago the usage was read, move on.
const TICK_MS = 30_000;

// The title bar's button that opens the Accounts panel.
export function AccountsButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const label = t('accounts.title');
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] hover:bg-hover hover:text-ink"
    >
      <Gauge className="size-3.5" />
    </button>
  );
}

interface AccountsPanelProps {
  bridge: Pick<AccountsBridge, 'setShown' | 'reset'>;
  accounts: ProviderAccount[];
  // Runs the provider's own sign-in command in a terminal.
  onSignIn: (provider: ProviderId) => void;
}

// The Accounts panel: each provider's sign-in, with Sign In while it is not signed in, and for a
// subscription its usage limits, each window's use and when it resets, in the window's language and
// local time, with when they were read; Codex's resets, with Reset Limits, which the main process asks
// the user to confirm. It shows what the app holds at once, and while it shows the main process reads
// anew what is more than five minutes old (ADR-0017).
export function AccountsPanel({ bridge, accounts, onSignIn }: AccountsPanelProps) {
  const { t } = useTranslation();
  const now = useNow(TICK_MS);
  const [outcomes, setOutcomes] = useState<Partial<Record<ProviderId, ResetOutcome>>>({});

  useEffect(() => {
    bridge.setShown(true).catch(report);
    return () => {
      bridge.setShown(false).catch(report);
    };
  }, [bridge]);

  const reset = (provider: ProviderId) => {
    bridge.reset(provider).then((outcome) => {
      if (outcome !== null) setOutcomes((shown) => ({ ...shown, [provider]: outcome }));
    }, report);
  };

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <ul className="flex flex-col">
        {accounts.map((account) => (
          <li
            key={account.provider}
            className="border-b border-dashed border-line py-3.5 first:pt-0 last:border-b-0"
          >
            <div className="flex items-baseline gap-3">
              <h3 className="min-w-0 flex-1 truncate font-bold">
                {t(`providers.${account.provider}`)}
              </h3>
              <span className="shrink-0 text-[12px] text-muted">
                {account.reading && account.signIn.state === 'unknown'
                  ? t('accounts.checking')
                  : signInText(t, account.signIn)}
              </span>
              {account.signIn.state === 'signed-out' && (
                <button
                  type="button"
                  onClick={() => {
                    onSignIn(account.provider);
                  }}
                  className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[12px] hover:bg-hover"
                >
                  {t('accounts.signIn')}
                </button>
              )}
            </div>
            <Usage account={account} now={now} />
            {account.resettable && account.usage !== undefined && (
              <div className="mt-2 flex items-center gap-3 text-[12px] text-muted">
                {account.usage.resets !== undefined && (
                  <span>{t('accounts.resetsLeft', { count: account.usage.resets })}</span>
                )}
                <button
                  type="button"
                  disabled={account.usage.resets === 0}
                  onClick={() => {
                    reset(account.provider);
                  }}
                  className="rounded-md border border-line px-2 py-0.5 text-ink enabled:hover:bg-hover disabled:text-faint"
                >
                  {t('accounts.reset')}
                </button>
                {outcomes[account.provider] !== undefined && (
                  <span role="status">
                    {t(`accounts.resetOutcome.${outcomes[account.provider] ?? 'reset'}`)}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A subscription's windows with when they were read, and why the last read could not read them anew;
// while none were ever read, a dashed bar and why they could not be; nothing otherwise.
function Usage({ account, now }: { account: ProviderAccount; now: number }) {
  const { t, i18n } = useTranslation();
  const { usage, usageProblem } = account;
  const provider = t(`providers.${account.provider}`);
  if (usage === undefined) {
    return usageProblem === undefined ? null : (
      <ul className="mt-2 flex flex-col gap-1.5">
        <li className="flex items-baseline gap-3 text-[12px]">
          <span className="w-36 shrink-0 truncate text-muted">{t('accounts.window.other')}</span>
          <UnknownBar />
          <span className="min-w-0 flex-1 text-faint">
            {problemText(t, usageProblem, provider)}
          </span>
        </li>
      </ul>
    );
  }
  return (
    <div className="mt-2">
      <ul className="flex flex-col gap-1.5">
        {usage.windows.map((window) => (
          <WindowRow
            key={`${String(window.span)}\n${window.model ?? ''}`}
            window={window}
            now={now}
          />
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-faint">
        {readText(t, readWhen(usage.readAt, now, i18n.language))}
        {usageProblem !== undefined && ` · ${problemText(t, usageProblem, provider)}`}
      </p>
    </div>
  );
}

// A window: its name, a bar of its use, the share used and when it resets. The bar takes the wait
// colour from 80% and the deletion colour once the window is used up.
function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const { t, i18n } = useTranslation();
  const name = windowName(t, window);
  const { used, resetsAt } = window;
  const fill =
    used === null ? '' : used >= 100 ? 'bg-del' : used >= NEARLY_USED ? 'bg-wait' : 'bg-ink';
  return (
    <li className="flex items-baseline gap-3 text-[12px]">
      <span className="w-36 shrink-0 truncate text-muted" title={name}>
        {name}
      </span>
      {used === null ? (
        <UnknownBar />
      ) : (
        <span
          role="meter"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
          className="mt-1.5 h-1.5 w-20 shrink-0 self-start overflow-hidden rounded-full border border-line"
        >
          <span className={`block h-full ${fill}`} style={{ width: `${String(used)}%` }} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        {used === null
          ? t('accounts.unreported')
          : t('accounts.used', { share: share(used, i18n.language) })}
        {resetsAt !== null && (
          <span className="text-faint">
            {' · '}
            {t('accounts.resets', { time: resetTime(resetsAt, now, i18n.language) })}
          </span>
        )}
      </span>
    </li>
  );
}

// A bar whose share is not known: its outline alone, dashed.
function UnknownBar() {
  return (
    <span
      aria-hidden="true"
      className="mt-1.5 h-1.5 w-20 shrink-0 self-start rounded-full border border-dashed border-faint"
    />
  );
}

// Why the usage could not be read, briefly: the provider could not fetch it for the sign-in it holds,
// the app could not ask the provider, or the provider answered in a shape this version does not read.
function problemText(
  t: ReturnType<typeof useTranslation>['t'],
  problem: UsageProblem,
  provider: string,
): string {
  return t(`accounts.problem.${problem}`, { provider });
}

// When the usage was read: just now, within the last minute, or how long ago.
function readText(t: ReturnType<typeof useTranslation>['t'], when: string | null): string {
  return when === null ? t('accounts.readNow') : t('accounts.readAt', { when });
}

function signInText(t: ReturnType<typeof useTranslation>['t'], signIn: SignIn): string {
  switch (signIn.state) {
    case 'signed-in':
      return t(`accounts.state.${signIn.method}`);
    case 'signed-out':
      return t('accounts.state.signedOut');
    case 'unknown':
      return t('accounts.state.unknown');
  }
}

function report(error: unknown): void {
  console.error('The accounts could not do that:', error);
}
