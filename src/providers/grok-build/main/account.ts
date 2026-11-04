import type { ClientConnection } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { AccountRead } from '../../../accounts/main/source';
import {
  problemOf,
  type SignIn,
  type UsageWindow,
  type WindowSpan,
} from '../../../accounts/shared/accounts';

// Grok Build's undocumented extension methods behind its text interface's /usage (ADR-0017): how it is
// signed in, which it answers from its own settings, and the plan's current period, which it reads
// from Grok's service. Checked as Grok Build 1.0.70 answers; an answer of another shape leaves the
// sign-in unknown or the usage unread.
export const AUTH_INFO = '_x.ai/auth/info';
export const BILLING = '_x.ai/billing';

// The method by which Grok's own sign-in, `grok login`, holds the account's token.
const OWN_SIGN_IN = 'cached_token';

// ACP's error for a request that needs a sign-in.
const AUTH_REQUIRED = -32000;

const authInfo = z.object({ methodId: z.string().nullable().optional() });
const billing = z.object({
  config: z.object({
    currentPeriod: z
      .object({ type: z.string().optional(), end: z.string().nullable().optional() })
      .nullable()
      .optional(),
    creditUsagePercent: z.number().nullable().optional(),
    billingPeriodEnd: z.string().nullable().optional(),
  }),
});

// How Grok is signed in: with the account its own sign-in stored, which holds the subscription, or
// otherwise with a key; signed out when it names no sign-in.
export function grokSignIn(answer: unknown): SignIn {
  const parsed = authInfo.safeParse(answer);
  if (!parsed.success) return { state: 'unknown' };
  const method = parsed.data.methodId;
  if (method == null || method === '') return { state: 'signed-out' };
  return { state: 'signed-in', method: method === OWN_SIGN_IN ? 'subscription' : 'key' };
}

// The plan's current period as a window: its span, the share of its credits used where the plan has
// included credits, and when it ends; none when the answer gives neither the share nor the end.
export function grokWindows(answer: unknown): UsageWindow[] | undefined {
  const parsed = billing.safeParse(answer);
  if (!parsed.success) return undefined;
  const { currentPeriod, creditUsagePercent, billingPeriodEnd } = parsed.data.config;
  const end = Date.parse(currentPeriod?.end ?? billingPeriodEnd ?? '');
  const used = creditUsagePercent == null ? null : Math.min(Math.max(creditUsagePercent, 0), 100);
  if (used === null && Number.isNaN(end)) return undefined;
  return [
    {
      span: spanOf(currentPeriod?.type),
      used,
      resetsAt: Number.isNaN(end) ? null : end,
    },
  ];
}

// The period's span from its type, such as USAGE_PERIOD_TYPE_WEEKLY.
function spanOf(type: string | undefined): WindowSpan | null {
  if (type === undefined) return null;
  if (type.endsWith('_DAILY')) return 'day';
  if (type.endsWith('_WEEKLY')) return 'week';
  if (type.endsWith('_MONTHLY')) return 'month';
  return null;
}

// The account through a Grok Build process: its sign-in, and for a subscription, when asked for, its
// current period, or why it could not be read.
export async function readGrokAccount(
  connection: ClientConnection,
  withUsage: boolean,
): Promise<AccountRead> {
  const signIn = grokSignIn(await connection.agent.request(AUTH_INFO, {}));
  if (!withUsage || signIn.state !== 'signed-in' || signIn.method !== 'subscription') {
    return { signIn };
  }
  let answer: unknown;
  try {
    answer = await connection.agent.request(BILLING, {});
  } catch (error) {
    return { signIn, usageProblem: problemOf(error) };
  }
  const windows = grokWindows(answer);
  return windows === undefined
    ? { signIn, usageProblem: 'unreadable' }
    : { signIn, usage: { windows } };
}

// Whether a prompt failed for want of a sign-in.
export function isSignInError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === AUTH_REQUIRED
  );
}
