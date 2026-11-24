import { z } from 'zod';
import type { JsonValue, Outcome } from '../../sessions/shared/automation';
import type { ScriptResult } from './page';

// What an agent's script in a page may be and take: its size, its result's size, how long it may
// run unless the agent asks for longer, how long at most, and how much of an error it gets back.
export const SCRIPT_LIMITS = {
  sourceBytes: 32 * 1024,
  resultBytes: 32 * 1024,
  defaultMs: 10_000,
  maxMs: 30_000,
  messageCharacters: 2_000,
} as const;

// The DevTools protocol's evaluation of a script in the top-level document's own context, as the
// browser's console evaluates what is typed into it: its last expression is its value, it may await
// at its top level, a promise it ends with is awaited, and the value comes back as JSON. Without a
// user gesture, so that it opens nothing a click could.
export function scriptEvaluation(script: string): object {
  return {
    expression: script,
    replMode: true,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  };
}

const evaluated = z.object({
  result: z
    .object({
      type: z.string().optional(),
      value: z.unknown().optional(),
      unserializableValue: z.string().optional(),
    })
    .optional(),
  exceptionDetails: z
    .object({
      text: z.string().optional(),
      exception: z.object({ description: z.string().optional() }).optional(),
    })
    .optional(),
});

// What an evaluation's answer says the script came to, within the result's limit.
export function scriptResult(answer: unknown): ScriptResult {
  const { result, exceptionDetails } = evaluated.parse(answer);
  if (exceptionDetails) {
    const message =
      exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'The script threw.';
    return { kind: 'error', message: message.slice(0, SCRIPT_LIMITS.messageCharacters) };
  }
  if (
    !result ||
    result.type === 'undefined' ||
    (!('value' in result) && result.unserializableValue === undefined)
  )
    return { kind: 'undefined' };
  // NaN, Infinity, -0 and big integers, which JSON has no words for.
  if (result.unserializableValue !== undefined)
    return { kind: 'value', value: result.unserializableValue };
  const value = (result.value ?? null) as JsonValue;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= SCRIPT_LIMITS.resultBytes) return { kind: 'value', value };
  const cut = Buffer.from(json).subarray(0, SCRIPT_LIMITS.resultBytes).toString().replace(/�$/, '');
  return { kind: 'value', truncated: true, json: cut };
}

// How a page answers for its script: by evaluating it, and by ending whatever script runs in it.
export interface ScriptChannel {
  evaluate(params: object): Promise<unknown>;
  terminate(): Promise<unknown>;
  // Whether the page or its connection has gone, which an evaluation that failed then means.
  gone(): boolean;
}

// Runs an agent's script in a page and waits for what it comes to, for as long as it may run. A
// script still running at its limit, or as the turn stops, is ended, as far as its page allows: one
// waiting on a promise has nothing running to end and may still go on in the page, so its outcome is
// unknown.
export async function runPageScript(
  page: ScriptChannel,
  script: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Outcome<ScriptResult>> {
  if (signal.aborted) return { status: 'cancelled-before-dispatch', effects: 'none' };
  const answer = page.evaluate(scriptEvaluation(script)).then(
    (value) => ({ kind: 'answer' as const, value }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: (() => void) | undefined;
  const ended = new Promise<{ kind: 'timeout' | 'stopped' }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    stopped = () => {
      resolve({ kind: 'stopped' });
    };
    signal.addEventListener('abort', stopped, { once: true });
  });
  try {
    const first = await Promise.race([answer, ended]);
    if (first.kind === 'answer') {
      try {
        return { status: 'verified', value: scriptResult(first.value) };
      } catch {
        return { status: 'indeterminate', reason: 'backend-lost', exclusionHeld: false };
      }
    }
    if (first.kind === 'failed') {
      // An evaluation the page refused, as one whose document went as the script navigated, says
      // why; one whose page or connection went has an unknown end.
      if (page.gone())
        return { status: 'indeterminate', reason: 'backend-lost', exclusionHeld: false };
      const message = first.error instanceof Error ? first.error.message : 'The script failed.';
      return {
        status: 'verified',
        value: { kind: 'error', message: message.slice(0, SCRIPT_LIMITS.messageCharacters) },
      };
    }
    void page.terminate().catch(() => undefined);
    return {
      status: 'indeterminate',
      reason: first.kind === 'timeout' ? 'timeout' : 'cancelled-after-dispatch',
      exclusionHeld: false,
    };
  } finally {
    clearTimeout(timer);
    if (stopped) signal.removeEventListener('abort', stopped);
  }
}
