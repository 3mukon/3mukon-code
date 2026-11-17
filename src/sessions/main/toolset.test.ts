import { expect, it } from 'vitest';
import { toolsetError } from './provider';

it('does not retain transport configuration in a displayed error or its cause', () => {
  const credential = 'synthetic-transport-only';
  const original = new Error(`Rejected Bearer ${credential}`, {
    cause: { headers: { Authorization: `Bearer ${credential}` } },
  });
  const safe = toolsetError(original, {
    url: 'http://127.0.0.1/mcp',
    credential,
    close: () => undefined,
  });
  expect(safe.message).toBe('Rejected Bearer [toolset access]');
  expect(safe.cause).toBeUndefined();
  expect(safe.stack).not.toContain(credential);
});
