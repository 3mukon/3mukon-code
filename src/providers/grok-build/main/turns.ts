import type { ContentBlock, StopReason } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { SessionEvent } from '../../../sessions/shared/events';

// Grok Build's extension messages about turns, which its own terminal client uses, as seen with Grok
// 1.0.70: an interjection that adds a message to the running turn, and the notices of a turn that Grok
// runs by itself.

// Adds a message to the running turn, with its images as content blocks, which Grok delivers at the
// turn's next safe point. With no turn running, Grok runs the message as a turn of its own (an
// `interject-fallback-` prompt), which no prompt request frames. After one without text, Grok's agent
// sends its client nothing more, though its turn goes on.
export const INTERJECT = '_x.ai/interject';

export interface InterjectParams {
  sessionId: string;
  text: string;
  interjectionId: string;
  content?: ContentBlock[];
}

// The interjection's text: the message's own, or for images sent alone a short text of the app's,
// which Grok sees and the session's activity does not show.
export function interjectionText(text: string, images: number): string {
  if (text.trim() !== '') return text;
  return images > 1 ? '(images attached)' : '(image attached)';
}

// Grok's queue of prompts changed; it names the prompt that Grok runs, while one runs.
export const QUEUE_CHANGED = '_x.ai/queue/changed';

const queueChanged = z.object({
  sessionId: z.string(),
  runningPromptId: z.string().nullish(),
});

export type QueueChanged = z.infer<typeof queueChanged>;

export function parseQueueChanged(params: unknown): QueueChanged {
  return queueChanged.parse(params);
}

// Grok's notices about a session, among them that a prompt's turn completed, and how, and that Grok
// retries a request to the model; each kind of notice keeps fields of its own in the update.
export const SESSION_NOTICE = '_x.ai/session_notification';

const sessionNotice = z.object({
  sessionId: z.string(),
  update: z.looseObject({
    sessionUpdate: z.string(),
    prompt_id: z.string().nullish(),
    stop_reason: z.string().nullish(),
  }),
});

export type SessionNotice = z.infer<typeof sessionNotice>;

export function parseSessionNotice(params: unknown): SessionNotice {
  return sessionNotice.parse(params);
}

const stopReasons: readonly string[] = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] satisfies StopReason[];

// Grok's state as it retries a request to the model that failed, as seen with Grok 1.0.70: retrying,
// with the retry it makes, of how many at most, and why. Its other states, exhausted and failed, come
// as it gives up, and the turn's end follows them, which ends the wait.
const retryState = z.object({
  sessionUpdate: z.literal('retry_state'),
  type: z.literal('retrying'),
  attempt: z.number().nullish().catch(undefined),
  max_retries: z.number().nullish().catch(undefined),
  reason: z.string().nullish().catch(undefined),
});

// The retry a notice says Grok makes; nothing for other notices.
export function retryOf(
  notice: SessionNotice,
): Extract<SessionEvent, { type: 'retrying' }> | undefined {
  const parsed = retryState.safeParse(notice.update);
  if (!parsed.success) return undefined;
  const { attempt, max_retries: maxRetries, reason } = parsed.data;
  return {
    type: 'retrying',
    ...(attempt == null ? {} : { attempt }),
    ...(maxRetries == null ? {} : { maxRetries }),
    ...(reason == null || reason === '' ? {} : { reason }),
  };
}

// The prompt whose turn a notice says completed, and the turn's stop reason; nothing for other notices.
export function completedTurn(
  notice: SessionNotice,
): { promptId: string; stopReason: StopReason } | undefined {
  const { sessionUpdate, prompt_id: promptId, stop_reason: reason } = notice.update;
  if (sessionUpdate !== 'turn_completed' || promptId == null) return undefined;
  const stopReason = stopReasons.includes(reason ?? '') ? (reason as StopReason) : 'end_turn';
  return { promptId, stopReason };
}
