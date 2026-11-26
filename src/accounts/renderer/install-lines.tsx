import { useTranslation } from 'react-i18next';
import { updatePending } from '../../installs/shared/installs';
import type { ProviderAccount } from '../shared/accounts';
import { share } from './format';

type T = ReturnType<typeof useTranslation>['t'];

// Whether the provider is installed: false where neither the user's CLI nor the app's copy runs, and
// true until the app knows (ADR-0039).
export function installed(account: ProviderAccount | undefined): boolean {
  return account?.install?.runs !== null;
}

// Whether to offer Sign In: while the provider is not signed in, or not installed, which its sign-in
// downloads; not while a download is under way.
export function signInOffered(account: ProviderAccount): boolean {
  if (account.install?.downloading !== undefined) return false;
  return account.signIn.state === 'signed-out' || !installed(account);
}

// What runs for the provider and why (ADR-0039): the user's CLI or the app's copy, with its version; a
// CLI of the user's that the app passed over; an update the next sign-in or session downloads; a
// download's progress; and why the last one failed, until one succeeds.
export function InstallLines({ account }: { account: ProviderAccount }) {
  const { t, i18n } = useTranslation();
  const view = account.install;
  if (view === undefined) return null;
  const lines: { key: string; text: string; tone?: string }[] = [];
  if (view.runs !== null) {
    lines.push({
      key: 'runs',
      text: t(`accounts.install.${view.runs.source}`, { version: view.runs.version }),
    });
  } else if (view.downloading === undefined) {
    lines.push({ key: 'runs', text: t('accounts.install.download', { version: view.pinned }) });
  }
  if (view.passedOver !== undefined) {
    const { path, version, oldest } = view.passedOver;
    lines.push({
      key: 'passed-over',
      text:
        version === null
          ? t('accounts.install.unread', { path })
          : t('accounts.install.older', { path, version, oldest }),
    });
  }
  if (updatePending(view) && view.downloading === undefined) {
    lines.push({ key: 'update', text: t('accounts.install.update', { version: view.pinned }) });
  }
  if (view.failed !== undefined && view.downloading === undefined) {
    lines.push({
      key: 'failed',
      text: t(`accounts.install.failed.${view.failed}`),
      tone: 'text-del',
    });
  }
  return (
    <div className="mt-1 flex flex-col gap-1 text-[12px] text-muted">
      {lines.map((line) => (
        <p key={line.key} className={`break-words ${line.tone ?? ''}`}>
          {line.text}
        </p>
      ))}
      {view.downloading !== undefined && (
        <Download
          version={view.pinned}
          received={view.downloading.received}
          total={view.downloading.total}
          t={t}
          language={i18n.language}
        />
      )}
    </div>
  );
}

// A download's bar and how far it has come, in percent where its size is known, and in megabytes
// otherwise.
export function Download({
  version,
  received,
  total,
  t,
  language,
}: {
  version: string;
  received: number;
  total: number | null;
  t: T;
  language: string;
}) {
  const percent = total === null || total === 0 ? null : Math.min(100, (received / total) * 100);
  const progress =
    percent === null
      ? new Intl.NumberFormat(language, {
          style: 'unit',
          unit: 'megabyte',
          maximumFractionDigits: 0,
        }).format(received / 1_000_000)
      : share(percent, language);
  const label = t('accounts.install.downloading', { version, progress });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5" role="status">
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null ? {} : { 'aria-valuenow': Math.round(percent) })}
        className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full border border-line"
      >
        <span
          className={`block h-full bg-ink ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
          style={percent === null ? undefined : { width: `${String(percent)}%` }}
        />
      </span>
      <span>{label}</span>
    </div>
  );
}
