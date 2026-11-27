import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_LIMITS } from '../shared/inbox';
import { inboxStorage, memoryInboxStorage, SessionInboxes, type InboxMessage } from './inbox';

const message = (to: string, sentAt: number, summary = 'Done') => ({
  from: 'parent',
  fromTitle: 'Parent',
  to,
  summary,
  body: `Body of ${summary}`,
  sentAt,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionInboxes', () => {
  it('keeps each session’s messages, the newest first, and says which are untold, the oldest first', () => {
    const inboxes = new SessionInboxes(memoryInboxStorage());
    const first = inboxes.send(message('a', 1, 'First'));
    const second = inboxes.send(message('a', 2, 'Second'));
    inboxes.send(message('b', 3, 'Elsewhere'));
    expect(inboxes.list('a').map((kept) => kept.summary)).toEqual(['Second', 'First']);
    expect(inboxes.untold('a').map((kept) => kept.id)).toEqual([first.id, second.id]);
    inboxes.told('a', [first.id]);
    expect(inboxes.untold('a').map((kept) => kept.id)).toEqual([second.id]);
  });

  it('marks a message read and told as its body is read, and gives nothing for another’s message', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(500);
    const inboxes = new SessionInboxes(memoryInboxStorage());
    const sent = inboxes.send(message('a', 1));
    expect(inboxes.read('b', sent.id)).toBeUndefined();
    expect(inboxes.read('a', sent.id)).toMatchObject({ readAt: 500, toldAt: 500 });
    expect(inboxes.untold('a')).toEqual([]);
  });

  it('names at most a notice’s messages at once', () => {
    const inboxes = new SessionInboxes(memoryInboxStorage());
    for (let index = 0; index < MESSAGE_LIMITS.notice + 5; index += 1) {
      inboxes.send(message('a', index));
    }
    expect(inboxes.untold('a')).toHaveLength(MESSAGE_LIMITS.notice);
  });

  it('keeps the newest messages of a full inbox, those read leaving first', () => {
    const inboxes = new SessionInboxes(memoryInboxStorage());
    const oldest = inboxes.send(message('a', 0, 'Oldest'));
    const read = inboxes.send(message('a', 1, 'Read'));
    inboxes.read('a', read.id);
    for (let index = 2; index <= MESSAGE_LIMITS.inbox; index += 1) {
      inboxes.send(message('a', index));
    }
    const kept = inboxes.list('a');
    expect(kept).toHaveLength(MESSAGE_LIMITS.inbox);
    expect(kept.some((entry) => entry.id === read.id)).toBe(false);
    expect(kept.some((entry) => entry.id === oldest.id)).toBe(true);
  });

  it('forgets the messages a session received, keeping those it sent', () => {
    const storage = memoryInboxStorage();
    const inboxes = new SessionInboxes(storage);
    inboxes.send(message('a', 1));
    inboxes.send({ ...message('parent', 2), from: 'a', fromTitle: 'Child' });
    inboxes.forget('a');
    expect(inboxes.list('a')).toEqual([]);
    expect(inboxes.list('parent')).toHaveLength(1);
    expect(storage.saved.at(-1)).toHaveLength(1);
  });
});

describe('inboxStorage', () => {
  it('saves the messages in the folder, and loads them in a later run, leaving out any of another shape', () => {
    const folder = mkdtempSync(join(tmpdir(), 'session-inbox-'));
    try {
      const inboxes = new SessionInboxes(inboxStorage(folder));
      const sent = inboxes.send(message('a', 1));
      inboxes.told('a', [sent.id]);
      const later = new SessionInboxes(inboxStorage(folder));
      const [kept] = later.list('a');
      expect(kept).toMatchObject({ id: sent.id, summary: 'Done', body: 'Body of Done' });
      expect(kept?.toldAt).toEqual(expect.any(Number));
      expect(kept?.readAt).toBeUndefined();
      expect(kept?.report).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('keeps a report of the app’s as a report', () => {
    const folder = mkdtempSync(join(tmpdir(), 'session-inbox-'));
    try {
      new SessionInboxes(inboxStorage(folder)).send({ ...message('a', 1), report: 'failed' });
      expect(new SessionInboxes(inboxStorage(folder)).list('a')[0]?.report).toBe('failed');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('leaves out an entry of another shape', () => {
    const folder = mkdtempSync(join(tmpdir(), 'session-inbox-'));
    try {
      const good: InboxMessage = { ...message('a', 1), id: 'm1' };
      writeFileSync(
        join(folder, 'session-inbox.json'),
        JSON.stringify({ messages: [good, { id: 'm2', to: 'a' }] }),
      );
      expect(inboxStorage(folder).load()).toEqual([good]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
