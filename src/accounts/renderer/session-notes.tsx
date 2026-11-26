import { useTranslation } from 'react-i18next';
import type { ProviderId } from '../../sessions/shared/events';
import { mostUsed, type ProviderAccount } from '../shared/accounts';
import { resetTime, share, windowName } from './format';
import { Download, installed } from './install-lines';
import { useNow } from './use-now';

// How often the notice's reset time moves on, which says the time alone today and the weekday after.
const TICK_MS = 60_000;

// The session page's notice, beside the context in use on the divider above the composer, once the
// session's provider has used 80% or more of a window or limit, or has reached it: the window, its
// share used and when it resets. A click opens the Accounts panel. It shows what the app holds and
// never asks the provider itself (ADR-0017).
export function UsageNotice({
  account,
  onOpen,
}: {
  account: ProviderAccount | undefined;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow(TICK_MS);
  const window = mostUsed(account?.usage);
  if (window?.used == null) return null;
  const name = windowName(t, window);
  const said =
    window.used >= 100
      ? t('accounts.notice.reached', { window: name })
      : t('accounts.notice.used', { window: name, share: share(window.used, i18n.language) });
  const resets =
    window.resetsAt === null
      ? ''
      : ` · ${t('accounts.resets', { time: resetTime(window.resetsAt, now, i18n.language) })}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('accounts.notice.open')}
      className={`shrink-0 text-[11px] leading-4 hover:underline ${window.used >= 100 ? 'text-del' : 'text-wait'}`}
    >
      {said}
      {resets}
    </button>
  );
}

// Says on a session page that its provider is not signed in, or not installed, with Sign In, which
// runs the provider's own sign-in command in a terminal, downloading the app's copy first where the
// provider is not installed (ADR-0039); while that download goes on, its progress instead, and once
// one has failed, why.
export function SignInPrompt({
  provider,
  account,
  onSignIn,
}: {
  provider: ProviderId;
  account?: ProviderAccount | undefined;
  onSignIn: (provider: ProviderId) => void;
}) {
  const { t, i18n } = useTranslation();
  const name = t(`providers.${provider}`);
  const view = account?.install;
  if (view?.downloading !== undefined) {
    return (
      <div className="my-3 font-sans text-[12px] text-ink">
        <Download
          version={view.pinned}
          received={view.downloading.received}
          total={view.downloading.total}
          t={t}
          language={i18n.language}
        />
      </div>
    );
  }
  return (
    <div className="my-3">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ink">
        <span>
          {installed(account)
            ? t('accounts.signInPrompt', { provider: name })
            : t('accounts.signInPromptInstall', { provider: name })}
        </span>
        <button
          type="button"
          onClick={() => {
            onSignIn(provider);
          }}
          className="rounded-md border border-line px-2 font-sans text-[12px] hover:bg-hover"
        >
          {t('accounts.signIn')}
        </button>
      </p>
      {view?.failed !== undefined && (
        <p className="mt-1 font-sans text-[12px] text-del">
          {t(`accounts.install.failed.${view.failed}`)}
        </p>
      )}
    </div>
  );
}
