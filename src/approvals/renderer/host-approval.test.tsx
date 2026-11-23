import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type {
  ApprovalRecord,
  HostApproval,
  OperationKind,
  TargetSummary,
} from '../../sessions/shared/automation';
import type { ApprovalAnswer } from '../../sessions/shared/events';
import { AnsweredHostApproval, HostApprovalBlock } from './host-approval';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const settle = () => act(() => Promise.resolve());
const PERSONAL = { id: 'Default', name: 'Personal' };
const chromeTab: TargetSummary = {
  ref: { id: 't1', kind: 'browser-tab', generation: 1 },
  owner: 's1',
  name: 'Inbox',
  address: 'https://mail.example.com/inbox?private=1',
  sharing: 'global',
  browser: 'chrome',
  profile: PERSONAL,
};
const mail: TargetSummary = {
  ref: { id: 'a1', kind: 'application', generation: 1 },
  owner: 's1',
  name: 'Mail',
};

function request(
  target: TargetSummary,
  kind: OperationKind = 'browser-tab',
  mayActivate = false,
): HostApproval {
  return {
    id: 'host:1',
    callId: 'call-1',
    source: 'host',
    operation: {
      id: 'op-1',
      owner: 's1',
      turn: 'turn-1',
      accessGeneration: 1,
      target: target.ref,
      kind,
      policyEpoch: 1,
      state: 'waiting',
      targetMayActivate: mayActivate,
      deadline: 0,
    },
    target,
    canAllowForSession: true,
    requestedAt: 0,
  };
}

describe('HostApprovalBlock', () => {
  it('asks to work on a page with the Chrome profile’s sign-ins, says how long each answer lasts, and answers from its buttons', async () => {
    const onAnswer = vi.fn<(answer: ApprovalAnswer) => Promise<void>>(() => Promise.resolve());
    render(
      <HostApprovalBlock
        request={request(chromeTab, 'browser-tab', true)}
        agent="Codex"
        onAnswer={onAnswer}
      />,
    );
    const block = screen.getByRole('region', {
      name: 'Work on mail.example.com in Chrome, signed in as you?',
    });
    within(block).getByText(
      'Codex wants to use the Personal profile’s sign-ins, in a tab it opens in Chrome.',
    );
    within(block).getByText(
      'Allow Once lasts until Codex is done with it or the turn ends; Allow for This Session lasts until the session ends or you end it.',
    );
    within(block).getByText('The page may bring Chrome to the front in response to a click.');
    expect(within(block).getByRole('button', { name: 'Allow Once' }).className).toContain('bg-ink');
    fireEvent.click(within(block).getByRole('button', { name: 'Allow for This Session' }));
    await settle();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ decision: 'allow-for-session' });
  });

  it('answers from the keys while it has the focus, a denial carrying the user’s message', async () => {
    const onAnswer = vi.fn<(answer: ApprovalAnswer) => Promise<void>>(() => Promise.resolve());
    render(<HostApprovalBlock request={request(chromeTab)} agent="Codex" onAnswer={onAnswer} />);
    const block = screen.getByRole('region', {
      name: 'Work on mail.example.com in Chrome, signed in as you?',
    });
    expect(within(block).queryByText(/to the front/)).toBeNull();
    fireEvent.keyDown(block, { key: 'Enter' });
    await settle();
    expect(onAnswer).toHaveBeenLastCalledWith({ decision: 'allow-once' });
    fireEvent.keyDown(block, { key: 'Enter', altKey: true });
    await settle();
    expect(onAnswer).toHaveBeenLastCalledWith({ decision: 'allow-for-session' });
    const field = within(block).getByRole('textbox', { name: 'Tell the agent what to do instead' });
    fireEvent.change(field, { target: { value: 'Use the exported CSV instead' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await settle();
    expect(onAnswer).toHaveBeenLastCalledWith({
      decision: 'deny',
      message: 'Use the exported CSV instead',
    });
  });

  it.each([
    [
      { ...chromeTab, sharing: 'app' as const, browser: 'embedded' as const, profile: undefined },
      'browser-tab' as const,
      'Work on mail.example.com in the app’s browser, signed in?',
      'Codex wants to use the sign-ins the app’s browser shares with every session.',
    ],
    [
      mail,
      'application-background' as const,
      'Observe and operate Mail in the background?',
      'Codex wants to see Mail’s windows and press its controls, without bringing it to the front.',
    ],
    [
      mail,
      'application-foreground' as const,
      'Use the keyboard and pointer in Mail?',
      'Codex wants to use the keyboard and pointer in Mail while it’s in front. Moving the mouse or typing pauses it.',
    ],
    [
      {
        ...mail,
        ref: { ...mail.ref, kind: 'system-dialog' as const },
        name: 'Open',
        applicationName: 'Mail',
      },
      'system-dialog' as const,
      'Use the dialog Mail opened?',
      'Codex wants to make a choice in the dialog Mail opened.',
    ],
  ])('words each kind of operation', (target, kind, heading, detail) => {
    render(<HostApprovalBlock request={request(target, kind)} agent="Codex" />);
    const block = screen.getByRole('region', { name: heading });
    within(block).getByText(detail);
    expect(within(block).queryByRole('button')).toBeNull();
  });

  it('says an application may come to the front by itself where it may', () => {
    render(
      <HostApprovalBlock request={request(mail, 'application-background', true)} agent="Codex" />,
    );
    screen.getByText('Mail may come to the front in response to an action.');
  });
});

describe('AnsweredHostApproval', () => {
  const answered = (answer: ApprovalRecord['answer'], grantId: string | null = 'g1') =>
    ({ request: request(chromeTab), answer, answeredAt: 1, grantId }) satisfies ApprovalRecord;

  it('says a grant still in force was allowed, with End, which ends it', async () => {
    const onEnd = vi.fn(() => Promise.resolve(true));
    render(
      <AnsweredHostApproval
        approval={answered({ decision: 'allow-for-session' })}
        grant="active"
        agent="Codex"
        onEnd={onEnd}
      />,
    );
    screen.getByText('Work on mail.example.com in Chrome, signed in as you?');
    screen.getByText('Allowed for this session');
    expect(document.querySelector('.lucide-shield-check')?.getAttribute('class')).toContain(
      'text-run',
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'End: Work on mail.example.com in Chrome, signed in as you?',
      }),
    );
    await settle();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('says when an ended grant ended, without End', () => {
    render(
      <AnsweredHostApproval
        approval={answered({ decision: 'allow-once' })}
        grant={{
          grant: {
            id: 'g1',
            target: chromeTab,
            summaryAt: 0,
            operationKind: 'browser-tab',
            scope: 'operation',
            issuedAt: 0,
          },
          endedAt: 2,
          reason: 'turn-ended',
        }}
        agent="Codex"
        onEnd={() => Promise.resolve(true)}
      />,
    );
    screen.getByText('Allowed once · ended as the turn ended');
    expect(screen.queryByRole('button', { name: /^End/ })).toBeNull();
    expect(document.querySelector('.lucide-shield-check')?.getAttribute('class')).toContain(
      'text-faint',
    );
  });

  it('says a denial, with the message it sent, and nothing once unanswered', () => {
    const view = render(
      <AnsweredHostApproval
        approval={answered({ decision: 'deny', message: 'Use the exported CSV instead' }, null)}
        grant={null}
        agent="Codex"
      />,
    );
    screen.getByText('Denied · “Use the exported CSV instead”');
    expect(document.querySelector('.lucide-shield-off')?.getAttribute('class')).toContain(
      'text-del',
    );
    view.rerender(<AnsweredHostApproval approval={answered(null)} grant={null} agent="Codex" />);
    expect(screen.queryByText(/Work on/)).toBeNull();
  });

  it('says when End did not go', async () => {
    render(
      <AnsweredHostApproval
        approval={answered({ decision: 'allow-once' })}
        grant="active"
        agent="Codex"
        onEnd={() => Promise.resolve(false)}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'End: Work on mail.example.com in Chrome, signed in as you?',
      }),
    );
    await settle();
    expect(screen.getByRole('status').textContent).toBe('It couldn’t be ended.');
  });
});
