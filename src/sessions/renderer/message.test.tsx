import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { Message } from './message';
import { TimelineActionsContext, type TimelineActions } from './timeline-actions';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function withActions(children: React.ReactNode) {
  const actions = { copyText: vi.fn(), imageMenu: vi.fn() } satisfies TimelineActions;
  render(<TimelineActionsContext value={actions}>{children}</TimelineActionsContext>);
  return actions;
}

describe('Message', () => {
  it('shows the agent’s message as Markdown and the user’s as plain text at first, and switches', () => {
    withActions(
      <>
        <Message role="agent" text="See **this**." agent="Codex CLI" />
        <Message role="user" text="Use **bold**." agent="Codex CLI" />
      </>,
    );
    expect(screen.getByText('this').tagName).toBe('STRONG');
    expect(screen.getByText('Use **bold**.')).toBeDefined();
    const [agentSwitch, userSwitch] = screen.getAllByRole('button', { name: /^Show as / });
    expect(agentSwitch?.textContent).toBe('MD');
    expect(userSwitch?.textContent).toBe('TXT');
    expect(userSwitch?.getAttribute('aria-label')).toBe('Show as Markdown');
    if (agentSwitch === undefined || userSwitch === undefined) throw new Error('No switches.');
    fireEvent.click(agentSwitch);
    fireEvent.click(userSwitch);
    expect(screen.getByText('See **this**.')).toBeDefined();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('copies the message’s own text, Markdown and all, and says so for a moment', () => {
    vi.useFakeTimers();
    const actions = withActions(<Message role="agent" text="Run `ls`." agent="Codex CLI" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(actions.copyText).toHaveBeenCalledExactlyOnceWith('Run `ls`.');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeDefined();
  });

  it('shows the user’s images above the text and the agent’s below, without tools for no text', () => {
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    const { container } = render(
      <>
        <Message role="user" text="Look" images={[image]} agent="Grok Build" />
        <Message role="agent" text="" images={[image]} agent="Grok Build" />
      </>,
    );
    const [user, agent] = [...container.querySelectorAll('.group')];
    const shown = user?.querySelector('img');
    if (shown === null || shown === undefined) throw new Error('The user’s image is not shown.');
    expect(shown.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    // The image comes before the text.
    const order = shown.compareDocumentPosition(screen.getByText('Look'));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(agent?.querySelector('img')).not.toBeNull();
    // A message without text has neither MD nor Copy, and its border never gives way.
    expect(agent?.querySelector('button[aria-label="Copy message"]')).toBeNull();
    expect(agent?.firstElementChild?.className).not.toContain('mask');
    expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(1);
  });

  it('lays MD or TXT and Copy over the top border, out of the flow, while hovered or focused', () => {
    const { container } = render(
      <>
        <Message role="user" text="Hi" agent="Codex CLI" />
        <Message role="thinking" text="Plan" agent="Codex CLI" />
      </>,
    );
    const tools = screen
      .getAllByRole('button', { name: 'Copy message' })
      .map((button) => button.parentElement?.className ?? '');
    expect(tools).toHaveLength(2);
    for (const look of tools) {
      expect(look).toContain('absolute');
      expect(look).toContain('opacity-0');
      expect(look).toContain('group-hover:opacity-100');
      expect(look).toContain('group-focus-within:opacity-100');
    }
    expect(
      screen.getAllByRole('button', { name: /^Show as / }).map((button) => button.textContent),
    ).toEqual(['TXT', 'MD']);
    // The bubble's border and the line above thinking give way beneath them while they show.
    const lines = [...container.querySelectorAll('span[aria-hidden="true"]')];
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.className).toContain('group-hover:[mask-size');
    expect(lines[1]?.className).toContain('border-dashed');
  });

  it('shows an image the agent’s Markdown carries, and one on the web as a link, unfetched', () => {
    render(
      <Message
        role="agent"
        text="![Chart](data:image/png;base64,iVBORw0KGgo=) ![Logo](https://example.com/logo.png)"
        agent="Claude Code"
      />,
    );
    expect(screen.getByRole('button', { name: 'Chart' }).querySelector('img')?.src).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(screen.getByRole('link', { name: 'Logo' }).getAttribute('href')).toBe(
      'https://example.com/logo.png',
    );
    expect(document.querySelectorAll('img')).toHaveLength(1);
  });

  it('shows thinking quieter, as Markdown at first', () => {
    const { container } = render(
      <Message role="thinking" text="**Plan** first" agent="Codex CLI" />,
    );
    expect(screen.getByText('Plan').tagName).toBe('STRONG');
    expect(container.firstElementChild?.className).toContain('text-faint');
  });
});
