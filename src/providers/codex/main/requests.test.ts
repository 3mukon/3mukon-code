import { describe, expect, it } from 'vitest';
import {
  approvalResult,
  commandApproval,
  fileChangeApproval,
  permissionsApproval,
  questionResult,
  userInputQuestion,
} from './requests';

const context = { cwd: '/work/app', now: 1000 };
const turn = { threadId: 't1', turnId: 'u1', itemId: 'i1', startedAtMs: 1 };

describe('approvals', () => {
  it('shows a command with the actions Codex made of it, and maps the answers', () => {
    const request = commandApproval(
      '7',
      {
        ...turn,
        kind: 'command',
        environmentId: null,
        reason: 'Needs the network',
        command: "/bin/zsh -lc 'curl -sI https://example.com'",
        cwd: '/work/app/src',
        commandActions: [{ type: 'unknown', command: 'curl -sI https://example.com' }],
      },
      context,
    );
    expect(request).toEqual({
      kind: 'command',
      request: {
        id: '7',
        action: 'command',
        reason: 'Needs the network',
        command: 'curl -sI https://example.com',
        cwd: 'src',
        canAllowForSession: true,
        denyByDefault: false,
        requestedAt: 1000,
      },
    });
    if (request.kind === 'question') throw new Error('Expected an approval.');
    expect(approvalResult(request, { decision: 'allow-once' })).toEqual({ decision: 'accept' });
    expect(approvalResult(request, { decision: 'allow-for-session' })).toEqual({
      decision: 'acceptForSession',
    });
    expect(approvalResult(request, { decision: 'deny' })).toEqual({ decision: 'decline' });
  });

  it('shows a file change with the paths and diff of its item', () => {
    const request = fileChangeApproval(
      '8',
      { ...turn, reason: null },
      { paths: ['notes.txt'], diff: '--- a/notes.txt\n' },
      context,
    );
    expect(request.request).toEqual({
      id: '8',
      action: 'edit',
      paths: ['notes.txt'],
      diff: '--- a/notes.txt\n',
      canAllowForSession: true,
      denyByDefault: false,
      requestedAt: 1000,
    });
  });

  it('grants the permissions asked for, for the turn or the session, or none', () => {
    const request = permissionsApproval(
      '9',
      {
        ...turn,
        environmentId: null,
        cwd: '/work/app',
        reason: 'To download',
        permissions: { network: { enabled: true }, fileSystem: null },
      },
      context,
    );
    expect(request.request).toMatchObject({
      action: 'permissions',
      title: 'Codex CLI asks for network access',
      reason: 'To download',
    });
    if (request.kind !== 'permissions') throw new Error('Expected a permissions request.');
    expect(approvalResult(request, { decision: 'allow-once' })).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    expect(approvalResult(request, { decision: 'allow-for-session' })).toMatchObject({
      scope: 'session',
    });
    expect(approvalResult(request, { decision: 'deny' })).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });
});

describe('questions', () => {
  it('asks Codex’s questions, and returns the chosen labels and typed text by question', () => {
    const request = userInputQuestion(
      '10',
      {
        ...turn,
        isBlocking: true,
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- the protocol still requires it.
        autoResolutionMs: null,
        questions: [
          {
            id: 'style',
            header: 'Style',
            question: 'Tabs or spaces?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'Tabs', description: '' },
              { label: 'Spaces', description: 'Two of them' },
            ],
          },
          {
            id: 'key',
            header: '',
            question: 'Your key?',
            isOther: false,
            isSecret: true,
            options: null,
          },
        ],
      },
      context,
    );
    expect(request.request).toEqual({
      id: '10',
      questions: [
        {
          id: 'style',
          header: 'Style',
          text: 'Tabs or spaces?',
          options: [{ label: 'Tabs' }, { label: 'Spaces', description: 'Two of them' }],
          multiSelect: false,
          freeText: true,
          secret: false,
        },
        {
          id: 'key',
          text: 'Your key?',
          options: [],
          multiSelect: false,
          freeText: true,
          secret: true,
        },
      ],
      requestedAt: 1000,
    });
    expect(
      questionResult({
        decision: 'answer',
        answers: { style: { selected: ['Tabs'], text: 'mostly' }, key: { selected: [] } },
      }),
    ).toEqual({ answers: { style: { answers: ['Tabs', 'mostly'] }, key: { answers: [] } } });
    expect(questionResult({ decision: 'decline' })).toEqual({ answers: {} });
  });
});
