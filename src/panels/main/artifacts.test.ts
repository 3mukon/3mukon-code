import { afterEach, expect, it, vi } from 'vitest';
import { Artifacts } from './artifacts';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoaGj4DwAFhAKAjM1mJgAAAABJRU5ErkJggg==';
afterEach(() => vi.useRealTimers());
it('enforces encoded dimensions, UTF-8 budgets, row shape and ownership, retaining referenced content across time', () => {
  vi.useFakeTimers();
  const store = new Artifacts();
  const image = {
    format: 'image' as const,
    title: 'Synthetic',
    mediaType: 'image/png' as const,
    data: png,
    width: 1,
    height: 1,
  };
  expect(store.put('a', { ...image, width: 100 })).toEqual({ code: 'invalid-request' });
  expect(store.put('a', { ...image, mediaType: 'image/jpeg' })).toEqual({
    code: 'invalid-request',
  });
  expect(store.put('a', { format: 'markdown', title: 'Long', text: '界'.repeat(90_000) })).toEqual({
    code: 'invalid-request',
  });
  expect(
    store.put('a', { format: 'table', title: 'Bad', columns: ['one'], rows: [[1, 2]] }),
  ).toEqual({ code: 'invalid-request' });
  const stored = store.put('a', image);
  if (!('id' in stored)) throw Error('No artifact');
  const { id } = stored;
  expect(store.get('b', id)).toBeNull();
  expect(store.get('a', id)).toEqual(image);
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  store.retain(new Set([id]));
  expect(store.get('a', id)).toEqual(image);
  store.retain(new Set());
  expect(store.get('a', id)).toBeNull();
});
