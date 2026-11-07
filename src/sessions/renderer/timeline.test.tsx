import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n, switchLanguage } from '../../i18n/renderer/i18n';
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
    render(
      <Timeline
        state={state}
        agent="Claude Code"
        renderRequest={(item, place) => (
          <p>{`${item.type} ${item.request.id}${place.oldestWaiting ? ' oldest' : ''}`}</p>
        )}
      />,
    );
    // The user's message at the right and the agent's at the left, both filled and without an outline,
    // each named for VoiceOver.
    const prompt = screen.getByText('Fix the build').closest('.rounded-lg');
    expect(prompt?.className).toContain('paper-bubble');
    expect(prompt?.querySelector('[class~="border"]')).toBeNull();
    expect(prompt?.parentElement?.className).toContain('justify-end');
    expect(prompt?.parentElement?.firstElementChild?.textContent).toBe('You:');
    const reply = screen.getByRole('link', { name: 'the docs' }).closest('.rounded-lg');
    expect(reply?.className).toContain('paper-bubble');
    expect(reply?.querySelector('[class~="border"]')).toBeNull();
    expect(reply?.parentElement?.className).toContain('justify-start');
    expect(reply?.parentElement?.firstElementChild?.textContent).toBe('Claude Code:');
    expect(screen.getByText('Looking at the logs').closest('.text-faint')).not.toBeNull();
    expect(screen.getByText('pnpm test').className).toContain('text-del');
    expect(screen.getByText('Failed')).toBeDefined();
    const change = screen.getByRole('button', { name: /src\/a\.ts/ });
    expect(change.textContent).toContain('+2−1');
    // A request shows as the page's composer renders it.
    screen.getByText('approval r1 oldest');
    expect(screen.getByText('The turn failed.')).toBeDefined();
    expect(screen.getByRole('link', { name: 'the docs' }).getAttribute('href')).toBe(
      'https://example.com',
    );
    expect(screen.getByText('Read the logs').parentElement?.className).toContain('line-through');
    expect(screen.getByText('Fix the test').parentElement?.className).toContain('text-ink');
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('shows a message on its way after the activity, and Working, while the session starts or resumes', () => {
    const { rerender } = render(
      <Timeline state={null} pending={{ text: 'Hello', images: [] }} agent="Codex CLI" />,
    );
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByText('Working')).toBeDefined();
    const past: SessionState = {
      ...initialSessionState(),
      closed: true,
      timeline: [{ type: 'message', id: 'm1', role: 'user', text: 'Earlier' }],
    };
    rerender(<Timeline state={past} pending={{ text: 'Again', images: [] }} agent="Codex CLI" />);
    const earlier = screen.getByText('Earlier');
    expect(
      earlier.compareDocumentPosition(screen.getByText('Again')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A session that is not running says nothing of its own: the next message resumes it.
    rerender(<Timeline state={past} agent="Codex CLI" />);
    expect(screen.queryByText('Working')).toBeNull();
    expect(screen.queryByText(/ended/)).toBeNull();
  });

  it('says under Working which retry the provider makes, of how many, and why, while it retries', () => {
    const reason = 'API error (status 500 Internal Server Error): Service temporarily unavailable';
    const state: SessionState = {
      ...initialSessionState(),
      turnRunning: true,
      retrying: { attempt: 3, maxRetries: 15, reason },
    };
    const { rerender } = render(<Timeline state={state} agent="Grok Build" />);
    const notice = screen.getByText(`Retrying, attempt 3 of 15: ${reason}`);
    expect(
      screen.getByText('Working').compareDocumentPosition(notice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A long reason shows on three lines at most, and whole in the tooltip.
    expect(notice.className).toContain('line-clamp-3');
    expect(notice.getAttribute('title')).toBe(reason);
    // A provider that says neither the most it makes nor why.
    rerender(<Timeline state={{ ...state, retrying: { attempt: 2 } }} agent="Codex CLI" />);
    expect(screen.getByText('Retrying, attempt 2').hasAttribute('title')).toBe(false);
    // Nothing of it while no turn runs.
    rerender(<Timeline state={{ ...state, turnRunning: false }} agent="Grok Build" />);
    expect(screen.queryByText(/Retrying/)).toBeNull();
  });

  it('says which retry the provider makes in Simplified Chinese too', async () => {
    const state: SessionState = {
      ...initialSessionState(),
      turnRunning: true,
      retrying: { attempt: 2, maxRetries: 10, reason: '529 overloaded' },
    };
    await act(async () => {
      switchLanguage(['zh-Hans']);
      await Promise.resolve();
    });
    try {
      render(<Timeline state={state} agent="Claude Code" />);
      expect(screen.getByText('正在重试，第 2 次，共 10 次：529 overloaded')).toBeDefined();
    } finally {
      await act(async () => {
        switchLanguage(['en-US']);
        await Promise.resolve();
      });
    }
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
