import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { AutomationLiveState, Operation, TargetSummary } from '../shared/automation';
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

// The line's words, whose target is drawn in the ink apart from the rest.
function words(text: string | RegExp): HTMLElement {
  return screen.getByText(
    (_, element) =>
      element instanceof HTMLElement &&
      element.classList.contains('truncate') &&
      (typeof text === 'string' ? element.textContent === text : text.test(element.textContent)),
  );
}

describe('AutomationLine', () => {
  it('shows nothing while the session uses no tab or application', () => {
    const { container } = render(
      <AutomationLine state={state({ resources: [] })} onShow={yes} onStop={yes} />,
    );
    expect(container.textContent).toBe('');
    cleanup();
    const before = render(<AutomationLine state={undefined} onShow={yes} onStop={yes} />);
    expect(before.container.textContent).toBe('');
  });

  it('names what the session uses in faint small type, the target in the ink, with its sharing and delivery, or the first and how many more', () => {
    const { container } = render(<AutomationLine state={state({})} onShow={yes} onStop={yes} />);
    words('Using example.com · No sharing · in the background');
    expect(screen.getByText('example.com').className).toContain('text-ink');
    expect(container.firstElementChild?.className).toContain('text-faint');
    expect(container.querySelector('[aria-hidden="true"]')?.className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Show' }).className).toContain('border-line');
    cleanup();
    render(
      <AutomationLine
        state={state({
          resources: [mail],
          operations: [operation({ target: mail.ref, kind: 'application-foreground' })],
        })}
        onShow={yes}
        onStop={yes}
      />,
    );
    words('Using Mail · in the foreground');
    cleanup();
    render(<AutomationLine state={state({ resources: [tab, mail] })} onShow={yes} onStop={yes} />);
    words('Using example.com · and 1 more');
    cleanup();
    // An application counts once, with the windows of it that the session knows.
    const inbox: TargetSummary = {
      ref: { id: 'window-1', kind: 'window', generation: 1 },
      owner: 's1',
      name: 'Inbox',
      applicationName: 'Mail',
      application: mail.ref,
    };
    const onShow = vi.fn(yes);
    render(
      <AutomationLine
        state={state({
          resources: [mail, inbox, { ...inbox, ref: { ...inbox.ref, id: 'window-2' } }],
          operations: [operation({ target: mail.ref, kind: 'application-background' })],
        })}
        onShow={onShow}
        onStop={yes}
      />,
    );
    words('Using Mail · in the background');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(onShow).toHaveBeenCalledWith([
      mail,
      inbox,
      { ...inbox, ref: { ...inbox.ref, id: 'window-2' } },
    ]);
  });

  it('says when it waits for the user, pauses or stops, and offers Stop only while there is work', () => {
    const waiting = render(
      <AutomationLine state={state({ phase: 'waiting-grant' })} onShow={yes} onStop={yes} />,
    );
    words('Waiting for your answer to use example.com · No sharing · in the background');
    expect(waiting.container.querySelector('[aria-hidden="true"]')?.className).toContain('bg-wait');
    cleanup();
    render(<AutomationLine state={state({ phase: 'stopping' })} onShow={yes} onStop={yes} />);
    words(/^Stopping in example\.com/);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    cleanup();
    render(
      <AutomationLine state={state({ phase: 'idle', operations: [] })} onShow={yes} onStop={yes} />,
    );
    expect(screen.getByRole('button', { name: 'Show' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('presents what the session uses with Show and stops its work with Stop, saying what failed', async () => {
    const onShow = vi.fn(() => Promise.resolve(false));
    const onStop = vi.fn(() => Promise.resolve(false));
    render(
      <AutomationLine state={state({ resources: [tab, mail] })} onShow={onShow} onStop={onStop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await settle();
    expect(onShow).toHaveBeenCalledWith([tab, mail]);
    expect(screen.getByRole('status').textContent).toBe('It can’t be shown now.');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toBe('It couldn’t be stopped.');
    onStop.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
