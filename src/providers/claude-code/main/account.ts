import { execFile } from 'node:child_process';
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SignIn, UsageWindow, WindowSpan } from '../../../accounts/shared/accounts';

// How long Claude Code may take to say how it is signed in.
const STATUS_TIMEOUT_MS = 15_000;

// What `claude auth status --json` says, as far as the app reads it (ADR-0017); it also names the
// account, which the app leaves alone.
const status = z.object({
  loggedIn: z.boolean(),
  apiProvider: z.string().optional(),
  subscriptionType: z.string().nullable().optional(),
});

// How Claude Code is signed in: through another backend, such as a cloud provider's, when its API
// provider is not Anthropic's own; with a subscription when it names one; otherwise with a key.
export function claudeSignIn(answer: unknown): SignIn {
  const parsed = status.safeParse(answer);
  if (!parsed.success) return { state: 'unknown' };
  const { loggedIn, apiProvider, subscriptionType } = parsed.data;
  if (!loggedIn) return { state: 'signed-out' };
  if (apiProvider !== undefined && apiProvider !== 'firstParty') {
    return { state: 'signed-in', method: 'backend' };
  }
  return {
    state: 'signed-in',
    method: subscriptionType == null || subscriptionType === '' ? 'key' : 'subscription',
  };
}

// Asks the binary how Claude Code is signed in, which it answers from its own settings without a
// model call. It says so in JSON whether or not it is signed in.
export function readClaudeSignIn(binary: string): Promise<SignIn> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['auth', 'status', '--json'],
      { timeout: STATUS_TIMEOUT_MS },
      (_error, stdout) => {
        try {
          resolve(claudeSignIn(JSON.parse(stdout)));
        } catch {
          resolve({ state: 'unknown' });
        }
      },
    );
  });
}

type Limits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
type ExperimentalWindow =
  { utilization: number | null; resets_at: string | null } | null | undefined;

// The plan's windows from the SDK's experimental usage call, whose use is in percent and whose reset
// is an ISO time: five hours, a week, and a week of some models alone. None when the call gives no
// windows, as when the plan's limits do not apply or Claude Code could not read them.
export function experimentalWindows(answer: SDKControlGetUsageResponse): UsageWindow[] | undefined {
  const limits: Limits | null = answer.rate_limits;
  if (!answer.rate_limits_available || limits === null) return undefined;
  const windows: UsageWindow[] = [];
  const add = (given: ExperimentalWindow, span: WindowSpan, model?: string) => {
    if (given == null) return;
    const resets = given.resets_at === null ? Number.NaN : Date.parse(given.resets_at);
    windows.push({
      span,
      ...(model === undefined ? {} : { model }),
      used: given.utilization === null ? null : clamp(given.utilization),
      resetsAt: Number.isNaN(resets) ? null : resets,
    });
  };
  add(limits.five_hour, 'five-hour');
  add(limits.seven_day, 'week');
  add(limits.seven_day_opus, 'week', 'Opus');
  add(limits.seven_day_sonnet, 'week', 'Sonnet');
  for (const scoped of limits.model_scoped ?? []) add(scoped, 'week', scoped.display_name);
  return windows;
}

// The window a rate-limit event reports during a turn, whose use is a fraction and whose reset is in
// seconds since the epoch; a window refused is wholly used.
export function eventWindows(info: SDKRateLimitInfo): UsageWindow[] {
  const named = spans[info.rateLimitType ?? ''];
  if (named === undefined) return [];
  const used =
    info.utilization !== undefined
      ? clamp(info.utilization * 100)
      : info.status === 'rejected'
        ? 100
        : null;
  return [
    {
      span: named.span,
      ...(named.model === undefined ? {} : { model: named.model }),
      used,
      resetsAt: info.resetsAt === undefined ? null : info.resetsAt * 1000,
    },
  ];
}

const spans: Record<string, { span: WindowSpan; model?: string } | undefined> = {
  five_hour: { span: 'five-hour' },
  seven_day: { span: 'week' },
  seven_day_opus: { span: 'week', model: 'Opus' },
  seven_day_sonnet: { span: 'week', model: 'Sonnet' },
};

function clamp(percent: number): number {
  return Math.min(Math.max(percent, 0), 100);
}
