import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../sessions/shared/events';
import { INBOX_CONTEXT_URI, inboxContext } from '../../../sessions/shared/inbox';
import { commandOf, currentChoices, toolArguments, toolNameOf, Translator } from './translate';

describe('the translation of Antigravity’s updates', () => {
  it('streams a message in chunks, and starts a new one once something comes between them', () => {
    const translator = new Translator('/work');
    const first = translator.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The command' },
    });
    const second = translator.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: ' printed:' },
    });
    expect(first[0]).toMatchObject({ type: 'message-delta', role: 'agent', text: 'The command' });
    expect(second[0]).toMatchObject({ id: (first[0] as { id: string }).id, text: ' printed:' });
    const thought = translator.update({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking' },
    });
    expect(thought[0]).toMatchObject({ role: 'thinking' });
    expect((thought[0] as { id: string }).id).not.toBe((first[0] as { id: string }).id);
  });

  it('shows a shell command by its command line, and its output once it completes', () => {
    const translator = new Translator('/work');
    const input = {
      CommandLine: 'echo probe-123',
      WaitMsBeforeAsync: 5000,
      toolSummary: 'Run echo command',
    };
    const started = translator.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'echo probe-123',
      kind: 'execute',
      status: 'in_progress',
      rawInput: input,
    });
    expect(started).toEqual([
      {
        type: 'tool',
        id: 'call-1',
        kind: 'execute',
        title: 'echo probe-123',
        status: 'running',
        command: 'echo probe-123',
      },
    ]);
    const output =
      'Created At: 2026-11-26T04:35:56-08:00\nCommand exited with code 0.\n\nCommand output:\nprobe-123\r\n';
    const completed = translator.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      rawInput: input,
      rawOutput: { output, exit_code: 0 },
      content: [{ type: 'content', content: { type: 'text', text: output } }],
    });
    expect(completed[0]).toMatchObject({ status: 'completed', output });
  });

  it('names a call of the app’s own tools by its tool, without the summary Antigravity adds', () => {
    const translator = new Translator('/work');
    const events = translator.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-2',
      title: 'Run mcp_3mukon-code_panel_list',
      kind: 'other',
      status: 'in_progress',
      rawInput: { toolSummary: 'List panels' },
      ...{ name: 'mcp_3mukon-code_panel_list' },
    });
    expect(events[0]).toMatchObject({
      type: 'tool',
      mcp: { server: '3mukon-code', tool: 'panel_list' },
    });
    // Another server's call keeps Antigravity's title.
    const other = translator.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-3',
      title: 'Run mcp_github_create_issue',
      kind: 'other',
    });
    expect(other[0]).not.toHaveProperty('mcp');
  });

  it('reports a completed call’s diffs as file changes, and the files it names', () => {
    const translator = new Translator('/work');
    translator.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit notes.md',
      kind: 'edit',
      locations: [{ path: '/work/notes.md' }],
    });
    const events = translator.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      content: [{ type: 'diff', path: '/work/notes.md', oldText: 'a\n', newText: 'b\n' }],
    });
    expect(events[0]).toMatchObject({ type: 'tool', paths: ['notes.md'], status: 'completed' });
    expect(events[1]).toMatchObject({
      type: 'file-change',
      toolId: 'edit-1',
      change: { path: 'notes.md', kind: 'update' },
    });
  });

  it('reports the context used, titles and the model and thinking level, and keeps Antigravity’s modes out', () => {
    const translator = new Translator('/work');
    expect(
      translator.update({ sessionUpdate: 'usage_update', used: 10425, size: 1048576 }),
    ).toEqual([{ type: 'context', used: 10425, size: 1048576 }]);
    expect(
      translator.update({
        sessionUpdate: 'session_info_update',
        title: 'Shell Tool Execution Probe',
      }),
    ).toEqual([{ type: 'title', title: 'Shell Tool Execution Probe' }]);
    expect(
      translator.update({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'gemini-3.8-flash',
            options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
          },
          {
            id: 'thought_level',
            name: 'Thinking Level',
            type: 'select',
            currentValue: 'low',
            options: [{ value: 'low', name: 'Low' }],
          },
        ],
      }),
    ).toEqual([{ type: 'settings', model: 'gemini-3.8-flash', effort: 'low' }]);
    expect(
      translator.update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
    ).toEqual([]);
  });

  it('gives back the notices of new messages from a replayed message’s resource, and nothing from another', () => {
    const translator = new Translator('/work');
    const notice = { id: 'n1', from: 'other', fromTitle: 'Other', summary: 'Done', sentAt: 5 };
    const replayed: SessionEvent[] = translator.update({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'resource',
        resource: {
          uri: INBOX_CONTEXT_URI,
          mimeType: 'text/plain',
          text: inboxContext([notice]) ?? '',
        },
      },
    });
    expect(replayed).toEqual([{ type: 'inbox', notices: [notice] }]);
    const other: SessionEvent[] = translator.update({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'resource',
        resource: { uri: 'app://other', mimeType: 'text/plain', text: 'not ours' },
      },
    });
    expect(other).toEqual([]);
  });
});

describe('the fields Antigravity adds', () => {
  it('reads a call’s name, its command and its own arguments', () => {
    expect(toolNameOf({ toolCallId: 'a', title: 'Run ask_question' })).toBe('ask_question');
    expect(toolNameOf({ toolCallId: 'a', title: 'echo hi', ...{ name: 'run_command' } })).toBe(
      'run_command',
    );
    expect(commandOf({ CommandLine: 'ls' })).toBe('ls');
    expect(commandOf({ toolSummary: 'nothing' })).toBeUndefined();
    expect(toolArguments({ toolSummary: 'x', query: 'y' })).toEqual({ query: 'y' });
  });

  it('reads the model and thinking level from the configuration options', () => {
    expect(currentChoices([])).toEqual({});
  });
});
