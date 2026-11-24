import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type {
  AutomationLiveState,
  HostApproval,
  Operation,
  TargetSummary,
} from '../shared/automation';
import { AutomationLine } from './automation-line';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const tab: TargetSummary = {
  ref: { id: 'tab-1', kind: 'browser-tab', generation: 1 },
  owner: 's1',
  name: 'Pricing · Example',
  address: 'https://example.com/pricing',
  sharing: 'none',
  browser: 'embedded',
};
const docs: TargetSummary = {
  ...tab,
  ref: { ...tab.ref, id: 'tab-2' },
  name: 'Docs',
  address: 'https://docs.example.com/start',
  sharing: 'app',
};
const mail: TargetSummary = {
  ref: { id: 'app-1', kind: 'application', generation: 1 },
  owner: 's1',
  name: 'Mail',
};
const operation = (fields: Partial<Operation>): Operation => ({
  id: 'op-1',
  owner: 's1',
  turn: 'turn-1',
  accessGeneration: 1,
  target: tab.ref,
  kind: 'browser-tab',
  policyEpoch: 1,
  state: 'active',
  targetMayActivate: false,
  deadline: 0,
  ...fields,
});

function state(fields: Partial<AutomationLiveState>): AutomationLiveState {
  return {
    sessionId: 's1',
    policy: { mode: 'auto', sandbox: 'workspace-write' },
    policyEpoch: 1,
    phase: 'acting',
    resources: [tab],
    operations: [operation({})],
    grants: [],
    pendingApprovals: [],
    foregroundOwner: null,
    availability: { tools: 'ready', images: 'supported' },
    ...fields,
  };
}

const settle = () => act(() => Promise.resolve());
const yes = () => Promise.resolve(true);
// Nothing the session uses shows in a panel.
const hidden = () => false;

// A row's words, whose target is drawn in the ink apart from the rest.
function words(text: string | RegExp): HTMLElement {
  return screen.getByText(
    (_, element) =>
      element instanceof HTMLElement &&
      element.tagName === 'SPAN' &&
      element.classList.contains('truncate') &&
      (typeof text === 'string' ? element.textContent === text : text.test(element.textContent)),
  );
}

describe('AutomationLine', () => {
  it('shows nothing while the session uses no tab or application', () => {
    const { container } = render(
      <AutomationLine shown={hidden} state={state({ resources: [] })} onShow={yes} onClose={yes} />,
    );
    expect(container.textContent).toBe('');
    cleanup();
    const before = render(
      <AutomationLine shown={hidden} state={undefined} onShow={yes} onClose={yes} />,
    );
    expect(before.container.textContent).toBe('');
  });

  it('names each tab and application on a row of its own, in faint small type, with its sharing and where it works, and offers no Stop', () => {
    const { container } = render(
      <AutomationLine shown={hidden} state={state({})} onShow={yes} onClose={yes} />,
    );
    words('Using example.com · No sharing · in the background');
    expect(screen.getByText('example.com').className).toContain('text-ink');
    expect(container.firstElementChild?.className).toContain('text-faint');
    expect(container.querySelector('[aria-hidden="true"]')?.className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Show: example.com' }).className).toContain(
      'border-line',
    );
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull();
    cleanup();
    render(
      <AutomationLine
        shown={hidden}
        state={state({
          resources: [tab, docs, mail],
          operations: [operation({ target: mail.ref, kind: 'application-foreground' })],
        })}
        onShow={yes}
        onClose={yes}
      />,
    );
    words('Using example.com · No sharing · in the background');
    words('Using docs.example.com · App sign-ins · in the background');
    words('Using Mail · in the foreground');
    // Only tabs close; an application stays as it is.
    expect(screen.getByRole('button', { name: 'Close: example.com' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Close: docs.example.com' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Close: Mail' })).toBeNull();
    cleanup();
    // An application counts once, with the windows of it that the session knows.
    const inbox: TargetSummary = {
      ref: { id: 'window-1', kind: 'window', generation: 1 },
      owner: 's1',
      name: 'Inbox',
      applicationName: 'Mail',
      application: mail.ref,
    };
    const second = { ...inbox, ref: { ...inbox.ref, id: 'window-2' } };
    const onShow = vi.fn(yes);
    render(
      <AutomationLine
        shown={hidden}
        state={state({
          resources: [mail, inbox, second],
          operations: [operation({ target: mail.ref, kind: 'application-background' })],
        })}
        onShow={onShow}
        onClose={yes}
      />,
    );
    words('Using Mail · in the background');
    fireEvent.click(screen.getByRole('button', { name: 'Show: Mail' }));
    expect(onShow).toHaveBeenCalledWith([mail, inbox, second]);
  });

  it('says for each row whether the session waits for the user, pauses or stops there', () => {
    const approval: HostApproval = {
      id: 'a1',
      callId: 'c1',
      source: 'host',
      operation: operation({ target: docs.ref, state: 'waiting' }),
      target: docs,
      canAllowForSession: true,
      requestedAt: 0,
    };
    const waiting = render(
      <AutomationLine
        shown={hidden}
        state={state({
          phase: 'waiting-grant',
          resources: [tab, docs],
          pendingApprovals: [approval],
        })}
        onShow={yes}
        onClose={yes}
      />,
    );
    words('Using example.com · No sharing · in the background');
    words('Waiting for your answer to use docs.example.com · App sign-ins · in the background');
    const dots = waiting.container.querySelectorAll('[aria-hidden="true"]');
    expect(dots[1]?.className).toContain('bg-wait');
    cleanup();
    render(
      <AutomationLine
        shown={hidden}
        state={state({
          phase: 'paused',
          operations: [],
          pausedTargets: [{ target: tab.ref, reason: 'user-input' }],
        })}
        onShow={yes}
        onClose={yes}
      />,
    );
    words(/^Paused in example\.com/);
    cleanup();
    render(
      <AutomationLine
        shown={hidden}
        state={state({ phase: 'stopping', operations: [operation({ state: 'stopping' })] })}
        onShow={yes}
        onClose={yes}
      />,
    );
    words(/^Stopping in example\.com/);
    cleanup();
    const idle = render(
      <AutomationLine
        shown={hidden}
        state={state({ phase: 'idle', operations: [] })}
        onShow={yes}
        onClose={yes}
      />,
    );
    words('Using example.com · No sharing · in the background');
    expect(idle.container.querySelector('[aria-hidden="true"]')?.className).not.toContain(
      'bg-accent',
    );
  });

  it('says a page a panel shows is in a panel, and offers Show only for what no panel shows', () => {
    const onShow = vi.fn(yes);
    const shownTab = (target: TargetSummary) => target.ref.id === tab.ref.id;
    render(
      <AutomationLine
        state={state({ resources: [tab, mail] })}
        shown={shownTab}
        onShow={onShow}
        onClose={yes}
      />,
    );
    words('Using example.com · No sharing · in a panel');
    expect(screen.queryByRole('button', { name: 'Show: example.com' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show: Mail' }));
    expect(onShow).toHaveBeenCalledWith([mail]);
    cleanup();
    // An application's preview never makes its work foreground or background: its delivery stays.
    render(
      <AutomationLine
        state={state({
          resources: [mail],
          operations: [operation({ target: mail.ref, kind: 'application-background' })],
        })}
        shown={() => true}
        onShow={onShow}
        onClose={yes}
      />,
    );
    words('Using Mail · in the background');
    expect(screen.queryByRole('button', { name: 'Show: Mail' })).toBeNull();
  });

  it('closes each tab from its own row, and says what could not be shown or closed', async () => {
    const onShow = vi.fn(() => Promise.resolve(false));
    const onClose = vi.fn(() => Promise.resolve(false));
    render(
      <AutomationLine
        shown={hidden}
        state={state({ resources: [tab, docs] })}
        onShow={onShow}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show: example.com' }));
    await settle();
    expect(onShow).toHaveBeenCalledWith([tab]);
    expect(screen.getByRole('status').textContent).toBe('It can’t be shown now.');
    fireEvent.click(screen.getByRole('button', { name: 'Close: docs.example.com' }));
    await settle();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(docs);
    expect(screen.getByRole('status').textContent).toBe('It couldn’t be closed.');
    onClose.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close: docs.example.com' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
