import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { approvalResult, questionResult, toRequest, type ToolPermissionOptions } from './requests';

const context = { cwd: '/work/app', now: 1000 };
const rule: PermissionUpdate = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'pnpm test' }],
  behavior: 'allow',
  destination: 'localSettings',
};

function options(extra: Partial<ToolPermissionOptions> = {}): ToolPermissionOptions {
  return { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1', ...extra };
}

function approval(
  toolName: string,
  input: Record<string, unknown>,
  extra?: Partial<ToolPermissionOptions>,
) {
  const request = toRequest(toolName, input, options(extra), context);
  if (request.kind !== 'approval') throw new Error('expected an approval');
  return request;
}

describe('approvals', () => {
  it('asks to run a command in the session folder, with Claude Code’s own wording', () => {
    const request = approval(
      'Bash',
      { command: 'pnpm test' },
      {
        title: 'Claude wants to run pnpm test',
        decisionReason: 'Not on the allow list',
        suggestions: [rule],
      },
    );
    expect(request.request).toEqual({
      id: 't1',
      action: 'command',
      title: 'Claude wants to run pnpm test',
      reason: 'Not on the allow list',
      command: 'pnpm test',
      cwd: '/work/app',
      canAllowForSession: true,
      denyByDefault: false,
      requestedAt: 1000,
    });
  });

  it('offers allow for the session only with suggested rules that may be kept', () => {
    expect(approval('Bash', { command: 'ls' }).request.canAllowForSession).toBe(false);
    expect(
      approval('Bash', { command: 'ls' }, { suggestions: [rule], suppressAlwaysAllowRule: true })
        .request.canAllowForSession,
    ).toBe(false);
    expect(approval('Bash', { command: 'ls' }, { defaultToNo: true }).request.denyByDefault).toBe(
      true,
    );
  });

  it('allows once, for the session with the suggested rules, or denies', () => {
    const request = approval('Bash', { command: 'pnpm test' }, { suggestions: [rule] });
    expect(approvalResult(request, { decision: 'allow-once' }, 'auto')).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
    });
    expect(approvalResult(request, { decision: 'allow-for-session' }, 'auto')).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
      updatedPermissions: [{ ...rule, destination: 'session' }],
    });
    expect(approvalResult(request, { decision: 'deny', message: 'Not now' }, 'auto')).toEqual({
      behavior: 'deny',
      message: 'Not now',
    });
  });

  it('shows an edit or a new file as a diff, and names other tools', () => {
    const edit = approval('Edit', {
      file_path: '/work/app/a.ts',
      old_string: 'x',
      new_string: 'y',
    }).request;
    expect(edit).toMatchObject({ action: 'edit', paths: ['a.ts'] });
    expect(edit.diff).toContain('+y');
    const write = approval('Write', { file_path: '/work/app/n.txt', content: 'hi' }).request;
    expect(write.diff).toContain('--- /dev/null');
    expect(approval('mcp__docs__search', { q: 'x' }).request).toMatchObject({
      action: 'tool',
      toolName: 'mcp__docs__search',
    });
  });

  it('asks to carry out a plan, which returns the session to its own mode', () => {
    const request = approval('ExitPlanMode', { plan: '1. Do it' }, { suggestions: [rule] });
    expect(request.request).toMatchObject({
      action: 'plan',
      plan: '1. Do it',
      canAllowForSession: false,
    });
    expect(approvalResult(request, { decision: 'allow-once' }, 'bypassPermissions')).toEqual({
      behavior: 'allow',
      updatedInput: { plan: '1. Do it' },
      updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
    });
    expect(approvalResult(request, { decision: 'deny' }, 'auto')).toMatchObject({
      behavior: 'deny',
    });
  });
});

describe('questions', () => {
  const input = {
    questions: [
      {
        question: 'Keep the terminal open by default?',
        header: 'Terminal',
        options: [
          { label: 'Collapsed', description: 'Hidden until opened' },
          { label: 'Expanded', description: 'Always shown' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which panels?',
        header: 'Panels',
        options: [{ label: 'Diff' }, { label: 'Tasks' }],
        multiSelect: true,
      },
    ],
  };

  it('turns AskUserQuestion into a question request', () => {
    const request = toRequest('AskUserQuestion', input, options(), context);
    if (request.kind !== 'question') throw new Error('expected a question');
    expect(request.request.questions[0]).toEqual({
      id: 'q0',
      header: 'Terminal',
      text: 'Keep the terminal open by default?',
      options: [
        { label: 'Collapsed', description: 'Hidden until opened' },
        { label: 'Expanded', description: 'Always shown' },
      ],
      multiSelect: false,
      freeText: true,
      secret: false,
    });
    expect(request.request.questions[1]?.multiSelect).toBe(true);
  });

  it('answers in the tool input, keyed by question text, or declines', () => {
    const request = toRequest('AskUserQuestion', input, options(), context);
    if (request.kind !== 'question') throw new Error('expected a question');
    expect(
      questionResult(request, {
        decision: 'answer',
        answers: {
          q0: { selected: ['Collapsed'] },
          q1: { selected: ['Diff', 'Tasks'], text: 'and logs' },
        },
      }),
    ).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: {
          'Keep the terminal open by default?': 'Collapsed',
          'Which panels?': 'Diff, Tasks, and logs',
        },
      },
    });
    expect(questionResult(request, { decision: 'decline' })).toMatchObject({ behavior: 'deny' });
  });
});
