import type { InstallView } from '../../installs/shared/installs';
import type { ProviderId } from '../../sessions/shared/events';

// How a provider is signed in: with a subscription, with an API key, or through another backend, such
// as a cloud provider's (ADR-0017). The account itself, its email among them, is never shown.
export type SignInMethod = 'subscription' | 'key' | 'backend';

// A provider's sign-in, as the provider last said; unknown until it has, or when it could not say.
export type SignIn =
  { state: 'signed-in'; method: SignInMethod } | { state: 'signed-out' } | { state: 'unknown' };

// What a usage window spans, which names it: five hours, a day, a week, a month, or another number of
// minutes.
export type WindowSpan = 'five-hour' | 'day' | 'week' | 'month' | number;

// One of a subscription's usage limits: a window of time in which the plan allows so much use.
export interface UsageWindow {
  // What the window spans; null when the provider does not say.
  span: WindowSpan | null;
  // The models the window holds alone, by the provider's name for them, such as Opus; missing for a
  // window of every model.
  model?: string;
  // How much of the window is used, in percent; null where the provider gives the window's reset but
  // not its use.
  used: number | null;
  // When the window resets, in milliseconds since the epoch; null when the provider does not say.
  resetsAt: number | null;
}

// Why a subscription's usage could not be read: the provider could not fetch it for the sign-in it
// holds, the app could not ask the provider, or the provider answered in a shape the app does not read.
export type UsageProblem = 'refused' | 'unreachable' | 'unreadable';

// What a failed request for the usage says of why: refused when the provider's message speaks of the
// sign-in or of access, unreachable otherwise.
export function problemOf(error: unknown): UsageProblem {
  const message = error instanceof Error ? error.message : String(error);
  return /unauthori[sz]ed|forbidden|\b40[13]\b|sign.?in|log.?in|auth/i.test(message)
    ? 'refused'
    : 'unreachable';
}

// A subscription's usage limits as the app last read them.
export interface Usage {
  windows: UsageWindow[];
  // How many resets of its limits the provider holds for the account, where it offers them.
  resets?: number;
  // When the app read them, in milliseconds since the epoch.
  readAt: number;
}

// What the app holds of a provider's account.
export interface ProviderAccount {
  provider: ProviderId;
  signIn: SignIn;
  // Where the provider's processes come from: the user's CLI or the app's own copy, or neither
  // (ADR-0039); missing until the app has looked.
  install?: InstallView;
  // A subscription's usage limits, once read, kept from an earlier run until read anew.
  usage?: Usage;
  // Why the last read of a subscription's usage could not give it, until one does.
  usageProblem?: UsageProblem;
  // The provider can reset its limits (Codex).
  resettable: boolean;
  // The app is asking the provider now.
  reading: boolean;
}

export interface AccountsList {
  // In the order the app offers the providers.
  accounts: ProviderAccount[];
}

// What spending a reset did: reset the limits, found nothing to reset, found no reset to spend, or
// found it spent already.
export type ResetOutcome = 'reset' | 'nothing-to-reset' | 'no-credit' | 'already-redeemed';

// How much of a window counts as nearly used up, from which the session pages say so.
export const NEARLY_USED = 80;

// The window most used, where one is used at least that much; for the session pages' notice.
export function mostUsed(usage: Usage | undefined, from = NEARLY_USED): UsageWindow | undefined {
  let most: UsageWindow | undefined;
  for (const window of usage?.windows ?? []) {
    if (window.used === null || window.used < from) continue;
    if (most === undefined || window.used > (most.used ?? 0)) most = window;
  }
  return most;
}

// What the window asks of the accounts' main-process side through the preload bridge.
export interface AccountsBridge {
  list(): Promise<AccountsList>;
  // Calls the listener with the accounts whenever they change, and returns a function that stops it.
  onChange(listener: (list: AccountsList) => void): () => void;
  // Says whether the window shows the Accounts panel, while which the main process reads anew what
  // is more than five minutes old, and does every five minutes.
  setShown(shown: boolean): Promise<void>;
  // Runs the provider's own sign-in command in a new terminal, and resolves with the terminal's id
  // and folder; the main process reads the sign-in again once the command ends.
  signIn(provider: ProviderId): Promise<{ id: string; cwd: string }>;
  // Spends one of the provider's resets once the user confirms; resolves with what it did, or null
  // when the user did not confirm.
  reset(provider: ProviderId): Promise<ResetOutcome | null>;
}
