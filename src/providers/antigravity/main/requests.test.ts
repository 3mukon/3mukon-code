import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  approvalResult,
  beyondLevel,
  formQuestion,
  formResult,
  permissionApproval,
} from './requests';

const OPTIONS: RequestPermissionRequest['options'] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

const context = { cwd: '/work', now: 1 };

describe('what lies beyond a sandbox level (ADR-0040)', () => {
  const edit = (path: string) => ({
    toolCallId: 'e',
    kind: 'edit' as const,
    locations: [{ path }],
  });
  const command = (bypass: boolean) => ({
    toolCallId: 'c',
    kind: 'execute' as const,
    rawInput: { CommandLine: 'npm install', ...(bypass ? { BypassSandbox: true } : {}) },
  });

  it('holds nothing at full access', () => {
    expect(beyondLevel(command(true), 'full-access', '/work')).toBe(false);
    expect(beyondLevel(edit('/etc/hosts'), 'full-access', '/work')).toBe(false);
  });

  it('holds edits and commands outside the sandbox at read-only, and nothing else', () => {
    expect(beyondLevel(edit('/work/a.md'), 'read-only', '/work')).toBe(true);
    expect(beyondLevel(command(true), 'read-only', '/work')).toBe(true);
    expect(beyondLevel(command(false), 'read-only', '/work')).toBe(false);
    expect(beyondLevel({ toolCallId: 'r', kind: 'read' }, 'read-only', '/work')).toBe(false);
  });

  it('holds commands outside the sandbox and edits outside the folder and the temporary folders at workspace-write', () => {
    expect(beyondLevel(command(true), 'workspace-write', '/work')).toBe(true);
    expect(beyondLevel(command(false), 'workspace-write', '/work')).toBe(false);
    expect(beyondLevel(edit('/work/src/a.ts'), 'workspace-write', '/work')).toBe(false);
    expect(beyondLevel(edit('src/a.ts'), 'workspace-write', '/work')).toBe(false);
    expect(beyondLevel(edit(join(tmpdir(), 'scratch.txt')), 'workspace-write', '/work')).toBe(
      false,
    );
    expect(beyondLevel(edit('/Users/me/.zshrc'), 'workspace-write', '/work')).toBe(true);
    expect(beyondLevel(edit('/work-other/a.ts'), 'workspace-write', '/work')).toBe(true);
    // An edit that names no file cannot be shown to stay inside.
    expect(beyondLevel({ toolCallId: 'e', kind: 'edit' }, 'workspace-write', '/work')).toBe(true);
  });
});

describe('an approval', () => {
  it('shows a command by its command line, offers allowing and denying once, and preselects denial beyond the level', () => {
    const params: RequestPermissionRequest = {
      sessionId: 's',
      toolCall: {
        toolCallId: 'c',
        kind: 'execute',
        title: 'echo probe-123',
        rawInput: { CommandLine: 'echo probe-123' },
      },
      options: OPTIONS,
    };
    const within = permissionApproval('r1', params, context, undefined, false);
    expect(within.request).toMatchObject({
      id: 'r1',
      action: 'command',
      command: 'echo probe-123',
      canAllowForSession: false,
      denyByDefault: false,
    });
    expect(permissionApproval('r2', params, context, undefined, true).request.denyByDefault).toBe(
      true,
    );
    expect(within.request.title).toBe('echo probe-123');
    // A command that would leave the sandbox says so, as it otherwise looks like the same command.
    const leaving: RequestPermissionRequest = {
      ...params,
      toolCall: {
        ...params.toolCall,
        rawInput: { CommandLine: 'echo probe-123', BypassSandbox: true },
      },
    };
    expect(permissionApproval('r3', leaving, context, undefined, true).request).toMatchObject({
      title: 'Antigravity asks to run this command outside its sandbox',
      command: 'echo probe-123',
      denyByDefault: true,
    });
    expect(approvalResult(OPTIONS, { decision: 'allow-once' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(approvalResult(OPTIONS, { decision: 'deny' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
    expect(approvalResult([], { decision: 'allow-once' })).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('names another tool by the name Antigravity gives it', () => {
    const params: RequestPermissionRequest = {
      sessionId: 's',
      toolCall: {
        toolCallId: 't',
        kind: 'other',
        title: 'Run mcp_github_create_issue',
        ...{ name: 'mcp_github_create_issue' },
      },
      options: OPTIONS,
    };
    expect(permissionApproval('r', params, context, undefined, false).request).toMatchObject({
      action: 'tool',
      toolName: 'mcp_github_create_issue',
    });
  });
});

describe('a question of Antigravity’s question tool', () => {
  // As Antigravity 1.5.18 asks one, through ACP's form elicitation.
  const form: CreateElicitationRequest = {
    sessionId: 's',
    toolCallId: 'call',
    mode: 'form',
    message: 'The agent has a question.',
    requestedSchema: {
      type: 'object',
      properties: {
        q1: {
          type: 'string',
          title: 'Do you prefer red or blue?',
          oneOf: [
            { const: '1', title: 'red' },
            { const: '2', title: 'blue' },
          ],
        },
        q1_other: {
          type: 'string',
          title: 'Other',
          description: 'Optional free-form answer to: Do you prefer red or blue?',
        },
        q2: {
          type: 'array',
          title: 'Which files?',
          items: {
            anyOf: [
              { const: 'a', title: 'a.ts' },
              { const: 'b', title: 'b.ts' },
            ],
          },
        },
      },
    },
  };

  it('shows each question with its choices, and typed text where the form takes it', () => {
    const built = formQuestion('q', form, context);
    expect(built?.request.questions).toEqual([
      {
        id: 'q1',
        text: 'Do you prefer red or blue?',
        options: [{ label: 'red' }, { label: 'blue' }],
        multiSelect: false,
        freeText: true,
        secret: false,
      },
      {
        id: 'q2',
        text: 'Which files?',
        options: [{ label: 'a.ts' }, { label: 'b.ts' }],
        multiSelect: true,
        freeText: false,
        secret: false,
      },
    ]);
  });

  it('answers with the choices’ values and the typed text, and declines a declined form', () => {
    const built = formQuestion('q', form, context);
    if (built === undefined) throw new Error('No question was built.');
    expect(
      formResult(built.fields, {
        decision: 'answer',
        answers: {
          q1: { selected: ['blue'], text: 'navy, really' },
          q2: { selected: ['a.ts', 'b.ts'] },
        },
      }),
    ).toEqual({ action: 'accept', content: { q1: '2', q1_other: 'navy, really', q2: ['a', 'b'] } });
    expect(formResult(built.fields, { decision: 'decline' })).toEqual({ action: 'decline' });
  });

  it('takes no elicitation but a form', () => {
    expect(
      formQuestion(
        'q',
        {
          sessionId: 's',
          mode: 'url',
          message: 'Open this',
          url: 'https://example.com',
          elicitationId: 'e',
        },
        context,
      ),
    ).toBeUndefined();
  });
});
