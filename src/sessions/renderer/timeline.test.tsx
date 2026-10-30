import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { initialSessionState, type SessionState } from '../shared/session-state';
import { Timeline } from './timeline';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

describe('Timeline', () => {
  it('shows the prompt, the agent’s Markdown, tool calls and changes as entries, requests, errors and tasks', () => {
    const state: SessionState = {
      ...initialSessionState(),
      timeline: [
        { type: 'message', id: 'm1', role: 'user', text: 'Fix the build' },
        { type: 'message', id: 'm2', role: 'thinking', text: 'Looking at the logs' },
        {
          type: 'tool',
          id: 't1',
          kind: 'execute',
          title: '',
          status: 'failed',
          command: 'pnpm test',
          output: '',
          changes: [],
        },
        {
          type: 'file-change',
          change: {
            id: 'f1',
            path: 'src/a.ts',
            kind: 'update',
            diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n',
          },
        },
        {
          type: 'approval',
          request: {
            id: 'r1',
            action: 'command',
            canAllowForSession: false,
            denyByDefault: false,
            requestedAt: 0,
          },
        },
        { type: 'error' },
        { type: 'message', id: 'm3', role: 'agent', text: 'See [the docs](https://example.com).' },
      ],
      tasks: [
        { text: 'Read the logs', status: 'completed' },
        { text: 'Fix the test', status: 'in_progress' },
      ],
    };
    render(<Timeline state={state} agent="Claude Code" />);
    // The user's message at the right, filled, and the agent's at the left, outlined, each named for
    // VoiceOver.
    const prompt = screen.getByText('Fix the build').closest('.rounded-lg');
    expect(prompt?.className).toContain('bg-bubble');
    expect(prompt?.parentElement?.className).toContain('justify-end');
    expect(prompt?.parentElement?.firstElementChild?.textContent).toBe('You:');
    const reply = screen.getByRole('link', { name: 'the docs' }).closest('.rounded-lg');
    expect(reply?.querySelector('.border-bubble-line')).not.toBeNull();
    expect(reply?.className).not.toContain('bg-bubble');
    expect(reply?.parentElement?.className).toContain('justify-start');
    expect(reply?.parentElement?.firstElementChild?.textContent).toBe('Claude Code:');
    expect(screen.getByText('Looking at the logs').closest('.text-faint')).not.toBeNull();
    expect(screen.getByText('pnpm test').className).toContain('text-del');
    expect(screen.getByText('Failed')).toBeDefined();
    const change = screen.getByRole('button', { name: /src\/a\.ts/ });
    expect(change.textContent).toContain('+2−1');
    expect(screen.getByText('Waiting for your approval')).toBeDefined();
    expect(screen.getByText('The turn failed.')).toBeDefined();
    expect(screen.getByRole('link', { name: 'the docs' }).getAttribute('href')).toBe(
      'https://example.com',
    );
    expect(screen.getByText('Read the logs').parentElement?.className).toContain('line-through');
    expect(screen.getByText('Fix the test').parentElement?.className).toContain('text-ink');
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('shows a first message on its way and Working while the session starts, and when it has ended', () => {
    const { rerender } = render(
      <Timeline state={null} starting={{ text: 'Hello', images: [] }} agent="Codex CLI" />,
    );
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByText('Working')).toBeDefined();
    rerender(<Timeline state={{ ...initialSessionState(), closed: true }} agent="Codex CLI" />);
    expect(screen.getByText('The session has ended.')).toBeDefined();
  });

  it('leaves raw HTML in an agent’s message out', () => {
    const state: SessionState = {
      ...initialSessionState(),
      timeline: [
        { type: 'message', id: 'm1', role: 'agent', text: 'Hi <img src=x onerror=alert(1)>' },
      ],
    };
    const { container } = render(<Timeline state={state} agent="Claude Code" />);
    expect(container.querySelector('img')).toBeNull();
  });
});
