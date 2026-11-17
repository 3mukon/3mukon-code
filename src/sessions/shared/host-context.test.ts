import { expect, it } from 'vitest';
import type { PresentationNotice } from './automation';
import { AUTOMATION_RESULT_LIMITS } from './automation';
import { presentationContext, selectPresentationNotices } from './host-context';

it('coalesces by owner and presentation at the newest version, budgeting the complete UTF-8 block', () => {
  const notice = (owner: string, id: string, version: number): PresentationNotice => ({
    owner,
    noticeId: `${id}-${String(version)}`,
    reuseKey: id,
    presentation: {
      id,
      version,
      title: 'Synthetic',
      items: [{ content: { kind: 'file', path: `/${'界'.repeat(1000)}` }, box: null }],
    },
  });
  const first = notice('a', 'same', 1);
  const second = notice('a', 'same', 2);
  const other = notice('b', 'same', 1);
  const values = [
    first,
    second,
    first,
    other,
    ...Array.from({ length: 50 }, (_, n) => notice('a', String(n), 1)),
  ];
  const selected = selectPresentationNotices(values);
  expect(selected).toContainEqual(second);
  expect(selected).toContainEqual(other);
  expect(selected).not.toContainEqual(first);
  expect(selected.length).toBeLessThan(52);
  const text = presentationContext(values) ?? '';
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
    AUTOMATION_RESULT_LIMITS.jsonBytes,
  );
  expect(JSON.parse(text)).toMatchObject({ presentations: selected });
  expect(presentationContext([])).toBeUndefined();
});
