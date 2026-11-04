import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountRead } from '../../../accounts/main/source';
import {
  problemOf,
  type ResetOutcome,
  type SignIn,
  type UsageWindow,
  type WindowSpan,
} from '../../../accounts/shared/accounts';
import type { Rpc } from './rpc';

// The answers of Codex's account calls, as far as the app reads them (ADR-0017). They are checked
// rather than taken from the protocol's types, which also describe the sign-ins the app never uses;
// an answer of another shape leaves the sign-in unknown or the usage unread.
const accountAnswer = z.object({
  account: z.object({ type: z.string() }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const window = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
});
const snapshot = z.object({
  primary: window.nullable().optional(),
  secondary: window.nullable().optional(),
});
const limitsAnswer = z.object({
  rateLimits: snapshot,
  rateLimitResetCredits: z.object({ availableCount: z.number() }).nullable().optional(),
});
const limitsUpdate = z.object({ rateLimits: snapshot });
const resetAnswer = z.object({
  outcome: z.enum(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']),
});
const errorNotice = z.object({ error: z.object({ codexErrorInfo: z.unknown() }) });

// How Codex is signed in: with a ChatGPT account's subscription, through Amazon Bedrock or a provider
// of the user's own that needs no OpenAI sign-in, or otherwise with a key; signed out when it has no
// account and needs one.
export function codexSignIn(answer: unknown): SignIn {
  const parsed = accountAnswer.safeParse(answer);
  if (!parsed.success) return { state: 'unknown' };
  const { account, requiresOpenaiAuth } = parsed.data;
  if (account === null) {
    return requiresOpenaiAuth ? { state: 'signed-out' } : { state: 'signed-in', method: 'backend' };
  }
  switch (account.type) {
    case 'chatgpt':
      return { state: 'signed-in', method: 'subscription' };
    case 'amazonBedrock':
      return { state: 'signed-in', method: 'backend' };
    default:
      return { state: 'signed-in', method: 'key' };
  }
}

// The windows of a rate-limit snapshot: Codex's primary and secondary windows, such as five hours and
// a week, with their use in percent and their reset in seconds since the epoch.
function windowsOf(limits: z.infer<typeof snapshot>): UsageWindow[] {
  return [limits.primary, limits.secondary].flatMap((given) =>
    given == null
      ? []
      : [
          {
            span: spanOf(given.windowDurationMins ?? null),
            used: Math.min(Math.max(given.usedPercent, 0), 100),
            resetsAt: given.resetsAt == null ? null : given.resetsAt * 1000,
          },
        ],
  );
}

function spanOf(minutes: number | null): WindowSpan | null {
  switch (minutes) {
    case null:
      return null;
    case 300:
      return 'five-hour';
    case 1440:
      return 'day';
    case 10080:
      return 'week';
    default:
      return minutes;
  }
}

// The account through an app-server: its sign-in, and for a subscription, when asked for, its windows
// and how many resets it holds, or why they could not be read. A background read leaves out the resets' details, which only their
// count needs.
export async function readCodexAccount(rpc: Rpc, withUsage: boolean): Promise<AccountRead> {
  const signIn = codexSignIn(await rpc.request('account/read', {}));
  if (!withUsage || signIn.state !== 'signed-in' || signIn.method !== 'subscription') {
    return { signIn };
  }
  let answer: unknown;
  try {
    answer = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true });
  } catch (error) {
    return { signIn, usageProblem: problemOf(error) };
  }
  const parsed = limitsAnswer.safeParse(answer);
  if (!parsed.success) return { signIn, usageProblem: 'unreadable' };
  const resets = parsed.data.rateLimitResetCredits?.availableCount;
  return {
    signIn,
    usage: {
      windows: windowsOf(parsed.data.rateLimits),
      ...(resets === undefined ? {} : { resets }),
    },
  };
}

// The windows a rate-limit update during a turn carries; an update of another shape carries none.
export function updatedWindows(params: unknown): UsageWindow[] {
  const parsed = limitsUpdate.safeParse(params);
  return parsed.success ? windowsOf(parsed.data.rateLimits) : [];
}

// Whether an error Codex reports during a turn is that it is not signed in.
export function isSignInError(params: unknown): boolean {
  const parsed = errorNotice.safeParse(params);
  return parsed.success && parsed.data.error.codexErrorInfo === 'unauthorized';
}

// Spends the next of the account's resets of its limits, as one attempt.
export async function resetCodexLimits(rpc: Rpc): Promise<ResetOutcome> {
  const { outcome } = resetAnswer.parse(
    await rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey: randomUUID() }),
  );
  switch (outcome) {
    case 'reset':
      return 'reset';
    case 'nothingToReset':
      return 'nothing-to-reset';
    case 'noCredit':
      return 'no-credit';
    case 'alreadyRedeemed':
      return 'already-redeemed';
  }
}
