import type { ProviderId } from '../../sessions/shared/events';
import type { ResetOutcome, SignIn, UsageProblem, UsageWindow } from '../shared/accounts';

// A program and its arguments, such as a provider's sign-in command.
export interface Program {
  file: string;
  args: string[];
}

// What a provider said of its account: its sign-in, and for a subscription, when asked for, its usage
// limits, or else why they could not be read; neither where it has none.
export interface AccountRead {
  signIn: SignIn;
  usage?: { windows: UsageWindow[]; resets?: number };
  usageProblem?: UsageProblem;
}

// What a provider reports of its account on its own, while its sessions run: windows of its usage
// limits as they change, which replace those of the same span and models, or that a turn failed for
// want of a sign-in.
export type AccountNews =
  { type: 'usage'; windows: UsageWindow[]; resets?: number } | { type: 'signed-out' };

// A provider's account, as its adapter reads it from the calls the provider offers (ADR-0017). Each
// adapter implements it beside the sessions interface, answering through a process it already runs for
// a session where one is open, and otherwise through one it starts for the purpose. Credentials never
// pass through it: the providers sign in through their own commands (ADR-0016).
export interface AccountSource {
  readonly id: ProviderId;
  // Reads the sign-in, with the usage limits when withUsage is set and the provider is signed in with
  // a subscription. Rejects when the provider could not be asked.
  readAccount(withUsage: boolean): Promise<AccountRead>;
  // The provider's own sign-in command, from the binary its sessions run with.
  signInCommand(): Promise<Program>;
  // Spends one of the provider's resets of its limits; only where the provider offers them.
  resetLimits?(): Promise<ResetOutcome>;
  // Calls the listener with what the provider reports of its account on its own, and returns a
  // function that stops it.
  onAccountNews(listener: (news: AccountNews) => void): () => void;
}
