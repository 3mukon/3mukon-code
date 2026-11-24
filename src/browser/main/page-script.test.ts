import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPageScript, SCRIPT_LIMITS, scriptEvaluation, scriptResult } from './page-script';

afterEach(() => vi.useRealTimers());

describe('scriptResult', () => {
  it('gives a value as JSON, no value, a value JSON has no words for, and the error thrown', () => {
    expect(scriptResult({ result: { type: 'number', value: 2 } })).toEqual({
      kind: 'value',
      value: 2,
    });
    expect(scriptResult({ result: { type: 'object', value: { a: [1, 'b'] } } })).toEqual({
      kind: 'value',
      value: { a: [1, 'b'] },
    });
    expect(scriptResult({ result: { type: 'object', subtype: 'null', value: null } })).toEqual({
      kind: 'value',
      value: null,
    });
    expect(scriptResult({ result: { type: 'undefined' } })).toEqual({ kind: 'undefined' });
    expect(scriptResult({ result: { type: 'number', unserializableValue: 'NaN' } })).toEqual({
      kind: 'value',
      value: 'NaN',
    });
    expect(
      scriptResult({
        result: { type: 'object' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: x is not a function' },
        },
      }),
    ).toEqual({ kind: 'error', message: 'TypeError: x is not a function' });
    expect(scriptResult({ exceptionDetails: { text: 'Uncaught SyntaxError' } })).toEqual({
      kind: 'error',
      message: 'Uncaught SyntaxError',
    });
  });

  it('cuts a value beyond 32 KiB of JSON as text, within the limit and without a broken character', () => {
    const big = scriptResult({ result: { type: 'string', value: 'é'.repeat(20_000) } });
    expect(big).toMatchObject({ kind: 'value', truncated: true });
    if (!('json' in big)) throw new Error('The value was not cut.');
    expect(Buffer.byteLength(big.json)).toBeLessThanOrEqual(SCRIPT_LIMITS.resultBytes);
    expect(big.json.startsWith('"éé')).toBe(true);
    expect(big.json.endsWith('�')).toBe(false);
  });
});

describe('runPageScript', () => {
  const channel = (evaluate: (params: object) => Promise<unknown>, gone = false) => ({
    evaluate: vi.fn(evaluate),
    terminate: vi.fn(() => Promise.resolve({})),
    gone: () => gone,
  });

  it('evaluates the script in the page’s own context, as the console does, and gives what it came to', async () => {
    const page = channel(() => Promise.resolve({ result: { type: 'string', value: 'Fixture' } }));
    expect(await runPageScript(page, 'document.title', 1000, new AbortController().signal)).toEqual(
      { status: 'verified', value: { kind: 'value', value: 'Fixture' } },
    );
    expect(page.evaluate).toHaveBeenCalledExactlyOnceWith({
      expression: 'document.title',
      replMode: true,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    expect(scriptEvaluation('document.title')).toEqual(page.evaluate.mock.calls[0]?.[0]);
    expect(page.terminate).not.toHaveBeenCalled();
  });

  it('ends a script still running at its limit or as the turn stops, whose outcome is then unknown', async () => {
    vi.useFakeTimers();
    const hanging = channel(() => new Promise(() => undefined));
    const timing = runPageScript(hanging, 'while (true) {}', 500, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(500);
    expect(await timing).toEqual({
      status: 'indeterminate',
      reason: 'timeout',
      exclusionHeld: false,
    });
    expect(hanging.terminate).toHaveBeenCalledOnce();
    const stop = new AbortController();
    const stopping = runPageScript(hanging, 'await new Promise(() => {})', 500, stop.signal);
    stop.abort();
    expect(await stopping).toEqual({
      status: 'indeterminate',
      reason: 'cancelled-after-dispatch',
      exclusionHeld: false,
    });
    expect(hanging.terminate).toHaveBeenCalledTimes(2);
    expect(await runPageScript(hanging, 'document.title', 500, stop.signal)).toEqual({
      status: 'cancelled-before-dispatch',
      effects: 'none',
    });
    expect(hanging.evaluate).toHaveBeenCalledTimes(2);
  });

  it('says why the page refused an evaluation, and that the end is unknown once the page has gone', async () => {
    const refused = channel(() => Promise.reject(new Error('Execution context was destroyed.')));
    expect(
      await runPageScript(refused, 'location.reload()', 1000, new AbortController().signal),
    ).toEqual({
      status: 'verified',
      value: { kind: 'error', message: 'Execution context was destroyed.' },
    });
    const gone = channel(() => Promise.reject(new Error('Chrome tab closed.')), true);
    expect(await runPageScript(gone, 'document.title', 1000, new AbortController().signal)).toEqual(
      { status: 'indeterminate', reason: 'backend-lost', exclusionHeld: false },
    );
  });
});
