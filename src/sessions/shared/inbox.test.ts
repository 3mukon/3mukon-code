import { describe, expect, it } from 'vitest';
import {
  INBOX_TEXT_HEAD,
  inboxContext,
  inboxNoticesOf,
  senderWords,
  withoutInboxText,
  type InboxNotice,
} from './inbox';

const message: InboxNotice = {
  id: 'm1',
  from: 'c1',
  fromTitle: 'Write the tests',
  summary: 'Tests pass',
  sentAt: 1,
};
const report: InboxNotice = {
  id: 'm2',
  from: 'c2',
  fromTitle: 'Review',
  summary: 'A turn of your child session “Review” ended in an error.',
  sentAt: 2,
  report: 'failed',
};

describe('the inbox block', () => {
  it('gives the notices back as a history holds them, reports with what they report', () => {
    const block = inboxContext([message, report]) ?? '';
    expect(block).toContain('the app’s own report on one of your child sessions');
    expect(inboxNoticesOf(block)).toEqual([message, report]);
    expect(inboxContext([])).toBeUndefined();
    expect(inboxNoticesOf('Fix the build')).toBeUndefined();
  });

  it('reads a report of an unknown kind as a message', () => {
    const block = JSON.stringify({
      source: '3mukon-code:inbox',
      messages: [{ ...report, report: 'exploded' }],
    });
    expect(inboxNoticesOf(block)).toEqual([
      { id: 'm2', from: 'c2', fromTitle: 'Review', summary: report.summary, sentAt: 2 },
    ]);
  });
});

describe('senderWords', () => {
  it('names a message’s sender, and the child a report is on', () => {
    expect(senderWords(message)).toBe('from Write the tests (c1)');
    expect(senderWords(report)).toBe('the app’s report on your child Review (c2)');
  });
});

describe('withoutInboxText', () => {
  it('cuts the notices the toolset adds after a session tool’s text, and leaves other text as it is', () => {
    expect(
      withoutInboxText(`Your inbox is empty.\n\n${INBOX_TEXT_HEAD}\n- m1: from Grok: ok`),
    ).toBe('Your inbox is empty.');
    expect(withoutInboxText('Started the child session')).toBe('Started the child session');
  });
});
