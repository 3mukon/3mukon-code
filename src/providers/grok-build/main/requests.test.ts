import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  approvalResult,
  parseAskUserQuestion,
  permissionApproval,
  questionResult,
  userQuestion,
} from './requests';

const context = { cwd: '/work', now: 1000 };

const OPTIONS: PermissionOption[] = [
  { optionId: 'always-allow', name: 'Always', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Never', kind: 'reject_always' },
];

function permission(toolCall: RequestPermissionRequest['toolCall']): RequestPermissionRequest {
  return { sessionId: 's1', toolCall, options: OPTIONS };
}

describe('approvals', () => {
  it('asks to run a command, offering to allow it once only', () => {
    expect(
      permissionApproval(
        'r1',
        permission({
          toolCallId: 't1',
          kind: 'execute',
          title: 'Execute `echo hi > a.txt`',
          rawInput: { variant: 'Bash', command: 'echo hi > a.txt' },
        }),
        context,
      ),
    ).toEqual({
      options: OPTIONS,
      request: {
        id: 'r1',
        action: 'command',
        title: 'Execute `echo hi > a.txt`',
        command: 'echo hi > a.txt',
        canAllowForSession: false,
        denyByDefault: false,
        requestedAt: 1000,
      },
    });
  });

  it('asks to edit with the edit’s paths and diff, and names any other tool', () => {
    const edit = permissionApproval(
      'r2',
      permission({
        toolCallId: 't2',
        kind: 'edit',
        title: 'Edit a.txt',
        locations: [{ path: '/work/a.txt' }],
        content: [{ type: 'diff', path: '/work/a.txt', oldText: 'one\n', newText: 'two\n' }],
      }),
      context,
    ).request;
    expect(edit).toMatchObject({ action: 'edit', paths: ['a.txt'] });
    expect(edit.diff).toBe('--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n');
    const other = permissionApproval(
      'r3',
      permission({ toolCallId: 't3', kind: 'fetch', title: 'Fetch a page', name: 'web_fetch' }),
      context,
    ).request;
    expect(other).toMatchObject({ action: 'tool', toolName: 'web_fetch' });
  });

  it('takes an edit’s file from its input, and what the call showed before from its updates', () => {
    const request = permission({
      toolCallId: 't4',
      title: 'Edit notes.txt',
      rawInput: { file_path: '/work/notes.txt', old_string: '', new_string: 'ok' },
    });
    expect(permissionApproval('r4', request, context).request).toMatchObject({
      action: 'tool',
      paths: ['notes.txt'],
    });
    const known = {
      kind: 'edit' as const,
      paths: ['notes.txt'],
      diffs: [{ path: '/work/notes.txt', oldText: '', newText: 'ok\n' }],
    };
    const approval = permissionApproval('r5', request, context, known).request;
    expect(approval).toMatchObject({ action: 'edit', paths: ['notes.txt'] });
    expect(approval.diff).toBe('--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,1 @@\n+ok\n');
  });

  it('answers with the once options only', () => {
    expect(approvalResult(OPTIONS, { decision: 'allow-once' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(approvalResult(OPTIONS, { decision: 'allow-for-session' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(approvalResult(OPTIONS, { decision: 'deny', message: 'No' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
    const onlyAlways = OPTIONS.filter((option) => option.kind.endsWith('always'));
    expect(approvalResult(onlyAlways, { decision: 'allow-once' })).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});

describe('questions', () => {
  const params = parseAskUserQuestion({
    sessionId: 's1',
    toolCallId: 't9',
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }],
        multiSelect: null,
      },
      { question: 'Which sizes?', options: [{ label: 'S' }, { label: 'M' }], multiSelect: true },
      { question: 'Why?' },
    ],
    mode: 'default',
  });

  it('shows Grok’s questions, each of which also takes typed text', () => {
    expect(userQuestion('q', params, context)).toEqual({
      texts: ['Which color?', 'Which sizes?', 'Why?'],
      request: {
        id: 'q',
        questions: [
          {
            id: 'q0',
            header: 'Color',
            text: 'Which color?',
            options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }],
            multiSelect: false,
            freeText: true,
            secret: false,
          },
          {
            id: 'q1',
            text: 'Which sizes?',
            options: [{ label: 'S' }, { label: 'M' }],
            multiSelect: true,
            freeText: true,
            secret: false,
          },
          {
            id: 'q2',
            text: 'Why?',
            options: [],
            multiSelect: false,
            freeText: true,
            secret: false,
          },
        ],
        requestedAt: 1000,
      },
    });
  });

  it('answers by question text, with the choices and the typed text joined', () => {
    const { texts } = userQuestion('q', params, context);
    expect(
      questionResult(texts, {
        decision: 'answer',
        answers: {
          q0: { selected: ['Red'] },
          q1: { selected: ['S', 'M'], text: 'XL too' },
          q2: { selected: [], text: 'Because' },
        },
      }),
    ).toEqual({
      outcome: 'accepted',
      answers: { 'Which color?': 'Red', 'Which sizes?': 'S, M, XL too', 'Why?': 'Because' },
      annotations: {},
    });
    expect(questionResult(texts, { decision: 'decline' })).toEqual({ outcome: 'cancelled' });
  });

  it('refuses a request without questions', () => {
    expect(() => parseAskUserQuestion({ sessionId: 's1', questions: [] })).toThrow();
  });
});
