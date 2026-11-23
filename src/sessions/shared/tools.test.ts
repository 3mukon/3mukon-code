import { describe, expect, it } from 'vitest';
import { appCall, mcpCall, toolWords, TOOLSET_NAME } from './tools';

describe('mcpCall', () => {
  it('marks a call of the app’s own toolset as the app’s, and any other server’s as its own', () => {
    expect(mcpCall(TOOLSET_NAME, 'session_list', {})).toEqual({
      server: TOOLSET_NAME,
      tool: 'session_list',
      app: true,
    });
    expect(mcpCall('github', 'create_issue', { title: 'Bug' })).toEqual({
      server: 'github',
      tool: 'create_issue',
    });
  });
});

describe('appCall', () => {
  it('takes what a call acts on from its arguments, on one line and cut short', () => {
    expect(
      appCall('message_send', { to: 's1', summary: '  Tests\n pass ', body: 'x' }),
    ).toMatchObject({
      subject: 'Tests pass',
    });
    expect(appCall('session_start', { prompt: 'Write the tests', title: 'Tester' }).subject).toBe(
      'Tester',
    );
    expect(appCall('session_start', { prompt: '\n\nWrite the tests\nfor search' }).subject).toBe(
      'Write the tests',
    );
    expect(appCall('panel_present', { title: 'Benchmarks' }).subject).toBe('Benchmarks');
    expect(appCall('browser_navigate', { url: 'https://example.com/a' }).subject).toBe(
      'https://example.com/a',
    );
    const long = appCall('message_send', { summary: 'word '.repeat(40) }).subject ?? '';
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('tells reading the inbox from reading one message, and leaves out what it cannot read', () => {
    expect(appCall('message_read', {}).action).toBe('message_read_inbox');
    expect(appCall('message_read', { messageId: 'm1' }).action).toBeUndefined();
    expect(appCall('session_end', { sessionId: 's1' })).toEqual({
      server: TOOLSET_NAME,
      tool: 'session_end',
      app: true,
    });
    expect(appCall('message_send', 'not arguments').subject).toBeUndefined();
  });
});

describe('toolWords', () => {
  it('splits a tool’s name into words, keeping the first word and capitals as they are', () => {
    expect(toolWords('EnterPlanMode')).toBe('Enter plan mode');
    expect(toolWords('create_issue')).toBe('create issue');
    expect(toolWords('read-mcp-resource')).toBe('read mcp resource');
    expect(toolWords('ListMCPResources')).toBe('List MCP resources');
    expect(toolWords('Bash')).toBe('Bash');
  });
});
