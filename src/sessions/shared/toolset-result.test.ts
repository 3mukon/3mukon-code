import { describe, expect, it } from 'vitest';
import { registeredTool, toolsetReceipt } from './toolset-result';

const envelope = {
  automation: { schemaVersion: 1, callId: 'fixture-call' },
  outcome: { status: 'verified', value: null },
  presentationNotices: [],
};
describe('native tool result envelopes', () => {
  it('reads the outer structured or first text envelope, including refused calls', () => {
    expect(toolsetReceipt(envelope, [])).toEqual(envelope.automation);
    expect(toolsetReceipt(undefined, [{ type: 'text', text: JSON.stringify(envelope) }])).toEqual(
      envelope.automation,
    );
    expect(
      toolsetReceipt({ ...envelope, outcome: { status: 'refused', code: 'sandbox-denied' } }, []),
    ).toEqual(envelope.automation);
  });
  it('never searches nested output, model prose or later text blocks', () => {
    expect(toolsetReceipt({ output: envelope }, [])).toBeUndefined();
    expect(toolsetReceipt(undefined, `Result: ${JSON.stringify(envelope)}`)).toBeUndefined();
    expect(
      toolsetReceipt(undefined, [
        { type: 'text', text: 'page' },
        { type: 'text', text: JSON.stringify(envelope) },
      ]),
    ).toBeUndefined();
    expect(
      toolsetReceipt({ ...envelope, automation: { schemaVersion: 2, callId: 'fixture-call' } }, []),
    ).toBeUndefined();
    expect(
      registeredTool('shell 3mukon-code__panel_list', '3mukon-code__', ['panel_list']),
    ).toBeUndefined();
    expect(registeredTool('3mukon-code__panel_list', '3mukon-code__', ['panel_list'])).toBe(
      'panel_list',
    );
    expect(registeredTool('3mukon-code__other', '3mukon-code__', ['panel_list'])).toBeUndefined();
  });
});
