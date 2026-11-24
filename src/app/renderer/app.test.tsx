import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeBrowserTabs } from '../../browser/shared/browser-fake';
import { initI18n } from '../../i18n/renderer/i18n';
import { initialSessionState } from '../../sessions/shared/session-state';
import type { SessionList, SessionSummary } from '../../sessions/shared/sessions';
import type { AppSettings } from '../../settings/shared/settings';
import type { WorkspaceList } from '../../workspaces/shared/workspaces';
import type {
  PresentationHostMessage,
  PresentationRendererMessage,
} from '../../panels/shared/presentation';
import type { BrowserViewPlacement } from '../../browser/shared/view';
import type {
  AutomationSnapshot,
  HostApproval,
  SetupSnapshot,
  TargetSummary,
} from '../../sessions/shared/automation';
import type { Bridge } from '../shared/bridge';
import { App } from './app';
import { FakeAutomationBridge, FakeUserSetupBridge } from '../../toolset/shared/automation-fake';

// Finds a line whose words are drawn in parts, such as a call's title, by all its words.
function textOf(words: string) {
  return (_: string, element: Element | null) =>
    element instanceof HTMLElement &&
    element.classList.contains('truncate') &&
    element.textContent === words;
}

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

// A bridge whose main process has these workspaces and sessions, the archived ones apart.
// What the setup reports before anything is connected or checked.
const NO_SETUP: SetupSnapshot = {
  appProfile: { id: 'embedded-app', canClear: true },
  chrome: {
    installedVersion: null,
    minimumVersion: '',
    connection: 'unavailable',
    profile: null,
  },
  computer: {
    helperName: 'Automation Helper',
    accessibility: 'unknown',
    screenRecording: 'unknown',
    inputMonitoring: { required: false, state: 'unknown' },
    restartRequired: false,
  },
};

function fakeBridge(
  list: WorkspaceList = { workspaces: [], selectedId: null },
  sessions: SessionSummary[] = [],
): Bridge {
  const archived = sessions.filter((session) => session.archived === true);
  const sessionList: SessionList = {
    sessions: sessions.filter((session) => session.archived !== true),
    archived: archived.length,
    shown: [],
  };
  const tabs = new FakeBrowserTabs();
  return {
    browser: {
      tabRef: () => Promise.resolve(null),
      snapshot: tabs.snapshot.bind(tabs),
      command: tabs.command.bind(tabs),
      subscribe: tabs.subscribe.bind(tabs),
      bind: () => Promise.resolve({ status: 'refused', code: 'not-found', dispatched: false }),
      place: () => Promise.resolve({ status: 'verified', value: { kind: 'paper' } }),
      release: () => Promise.resolve(),
      onFocus: () => () => undefined,
      onFileDrag: () => () => undefined,
    },
    computer: {
      preview: () => Promise.resolve({ status: 'refused', code: 'not-found', dispatched: false }),
      command: () => Promise.resolve({ status: 'refused', code: 'not-found', dispatched: false }),
    },
    automation: new FakeAutomationBridge(),
    setup: new FakeUserSetupBridge(NO_SETUP),
    presentations: {
      onMessage: () => () => undefined,
      send: () => undefined,
      artifact: () => Promise.resolve(null),
    },
    workspaces: {
      get: () => Promise.resolve(list),
      onChange: () => () => undefined,
      add: () => Promise.resolve(),
      addDropped: () => Promise.resolve(),
      select: () => Promise.resolve(),
      showMenu: () => Promise.resolve(null),
      listFolder: () => Promise.resolve({ entries: [] }),
    },
    sessions: {
      list: () => Promise.resolve(sessionList),
      onChange: () => () => undefined,
      archived: () => Promise.resolve(archived),
      resume: () => Promise.resolve(),
      showMenu: () => Promise.resolve(null),
      act: () => Promise.resolve(null),
      search: () => Promise.resolve({ matches: [], unread: 0 }),
      providers: () => Promise.resolve(['claude-code']),
      dayFolder: () => Promise.resolve('/Users/me/3mukon-code/2026-10-28'),
      gateways: () => Promise.resolve([]),
      models: () => Promise.resolve([]),
      choices: () => Promise.resolve({ folders: {}, dayRoot: '/Users/me/3mukon-code' }),
      rememberChoice: () => Promise.resolve(),
      confirmYolo: () => Promise.resolve(false),
      start: () => Promise.resolve('s9'),
      send: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      setMode: () => Promise.resolve(false),
      setGateway: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      setEffort: () => Promise.resolve(),
      setSandbox: () => Promise.resolve(),
      copyText: () => Promise.resolve(),
      copyImage: () => Promise.resolve(),
      saveImage: () => Promise.resolve(false),
      imageMenu: () => Promise.resolve(null),
      snapshot: () => Promise.resolve(null),
      preload: () => Promise.resolve(),
      onEvent: () => () => undefined,
    },
    panels: { itemsAt: () => Promise.resolve([]) },
    files: {
      open: () => Promise.resolve({ kind: 'text', text: '', bom: false }),
      save: () => Promise.resolve({ saved: true }),
      watch: () => Promise.resolve(),
      onChange: () => () => undefined,
      confirmClose: () => Promise.resolve('cancel'),
      image: () => Promise.resolve(null),
    },
    approvals: {
      answerApproval: () => Promise.resolve(),
      answerQuestion: () => Promise.resolve(),
    },
    settings: {
      initial: { language: 'system', appearance: 'system', tooltips: false, sidebarHidden: false },
      get: () =>
        Promise.resolve({
          language: 'system',
          appearance: 'system',
          tooltips: false,
          sidebarHidden: false,
        }),
      set: () => Promise.resolve(),
      onChange: () => () => undefined,
    },
    terminal: {
      open: () => Promise.resolve({ id: 't1', cwd: '/Users/me', program: 'zsh' }),
      write: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      onOutput: () => () => undefined,
      onExit: () => () => undefined,
      confirmClose: () => Promise.resolve(true),
      close: () => Promise.resolve(),
      openLink: () => Promise.resolve(),
    },
    accounts: {
      list: () => Promise.resolve({ accounts: [] }),
      onChange: () => () => undefined,
      setShown: () => Promise.resolve(),
      signIn: () => Promise.resolve({ id: 't2', cwd: '/Users/me' }),
      reset: () => Promise.resolve(null),
    },
    prompts: { onPrompt: () => () => undefined, answer: () => Promise.resolve() },
  };
}

// Renders the shell and lets the bridge's first answers arrive.
async function renderApp(bridge = fakeBridge()) {
  await act(async () => {
    render(<App bridge={bridge} />);
    await Promise.resolve();
  });
}

it('keeps one terminal subscription through StrictMode replay and releases it when the shell unmounts', async () => {
  const bridge = fakeBridge();
  const outputs = new Set<Parameters<Bridge['terminal']['onOutput']>[0]>();
  const exits = new Set<Parameters<Bridge['terminal']['onExit']>[0]>();
  bridge.terminal.onOutput = (listener) => {
    outputs.add(listener);
    return () => {
      outputs.delete(listener);
    };
  };
  bridge.terminal.onExit = (listener) => {
    exits.add(listener);
    return () => {
      exits.delete(listener);
    };
  };
  await act(async () => {
    render(
      <StrictMode>
        <App bridge={bridge} />
      </StrictMode>,
    );
    await Promise.resolve();
  });
  expect(outputs.size).toBe(1);
  expect(exits.size).toBe(1);
  cleanup();
  expect(outputs.size).toBe(0);
  expect(exits.size).toBe(0);
});

// The frame that ends a drag, after which what it dropped opens.
const dropped = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(resolve);
        });
      }),
  );

describe('App', () => {
  it('opens a terminal with ⌃` in the selected workspace’s folder, beside the focused panel in its folder, and ends one as its panel closes', async () => {
    const bridge = fakeBridge({
      workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
      selectedId: 'w1',
    });
    let next = 0;
    const open = vi.spyOn(bridge.terminal, 'open').mockImplementation((cwd) => {
      next += 1;
      return Promise.resolve({ id: `t${String(next)}`, cwd: cwd ?? '/Users/me', program: 'zsh' });
    });
    const close = vi.spyOn(bridge.terminal, 'close');
    await renderApp(bridge);
    const main = screen.getByRole('main');
    const press = async () => {
      await act(async () => {
        fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true });
        await Promise.resolve();
      });
    };
    await press();
    expect(open.mock.calls).toEqual([['/Users/me/web']]);
    await press();
    expect(open.mock.calls).toEqual([['/Users/me/web'], ['/Users/me/web']]);
    const terminals = within(main).getAllByRole('region', { name: 'Terminal' });
    expect(terminals).toHaveLength(2);
    await act(async () => {
      fireEvent.click(within(terminals[1] ?? main).getByRole('button', { name: 'Close panel' }));
      await Promise.resolve();
    });
    expect(within(main).getAllByRole('region', { name: 'Terminal' })).toHaveLength(1);
    expect(close.mock.calls).toEqual([['t2']]);
  });

  it('opens the accounts from the gauge, whose Sign In runs the provider’s sign-in in a terminal', async () => {
    const bridge = fakeBridge();
    vi.spyOn(bridge.accounts, 'list').mockResolvedValue({
      accounts: [
        { provider: 'codex', signIn: { state: 'signed-out' }, resettable: true, reading: false },
      ],
    });
    const signIn = vi.spyOn(bridge.accounts, 'signIn');
    await renderApp(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    const main = screen.getByRole('main');
    const accounts = within(main).getByRole('region', { name: 'Accounts' });
    await act(async () => {
      fireEvent.click(within(accounts).getByRole('button', { name: 'Sign In' }));
      await Promise.resolve();
    });
    expect(signIn.mock.calls).toEqual([['codex']]);
    expect(within(main).getByRole('region', { name: 'Terminal' })).toBeTruthy();
  });

  it('shows the sidebar beside a blank main area, with no title text', async () => {
    await renderApp();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    within(sidebar).getByText('3mukon-code');
    // Add workspace and New session sit beside their headings as plus icons, and no empty-state text
    // stands in for the workspaces and sessions that do not exist yet.
    const workspaces = within(sidebar).getByRole('region', { name: 'Workspaces' });
    const add = within(workspaces).getByRole('button', { name: 'Add workspace' });
    expect(
      within(workspaces).getByRole('heading', { name: 'Workspaces' }).parentElement?.contains(add),
    ).toBe(true);
    expect(workspaces.textContent).toBe('Workspaces');
    const sessions = within(sidebar).getByRole('region', { name: 'Sessions' });
    const heading = within(sessions).getByRole('heading', { name: 'Sessions' });
    const newSession = within(sessions).getByRole('button', { name: 'New session' });
    expect(heading.parentElement?.contains(newSession)).toBe(true);
    expect(sessions.textContent).toBe('Sessions');
    // The Workspaces section comes first, and a thin line, hidden from VoiceOver, separates the two.
    const line = workspaces.nextElementSibling;
    expect(line?.nextElementSibling).toBe(sessions);
    expect(line?.getAttribute('aria-hidden')).toBe('true');
    expect(line?.className).toContain('border-line');
    // The sidebar's heading is the only place the name appears.
    expect(screen.getAllByText('3mukon-code')).toHaveLength(1);
    expect(screen.getByRole('main').textContent).toBe('');
  });

  it('shows the workspaces and the sessions the bridge reports, and offers the workspaces as filters', async () => {
    await renderApp(
      fakeBridge(
        {
          workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
          selectedId: 'w1',
        },
        [
          {
            id: 's1',
            provider: 'codex',
            sessionId: 'thread-1',
            cwd: '/Users/me/web',
            title: 'Fix the build',
            status: 'running',
            activeAt: 1,
          },
        ],
      ),
    );
    screen.getByRole('treeitem', { name: 'web' });
    within(screen.getByRole('region', { name: 'Sessions' })).getByText('Fix the build');
    const filter = screen.getByRole('combobox', { name: 'Filter sessions by workspace' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All workspaces', 'web']);
  });

  it('opens a tree row in the panel area, whose top-left header clears the window buttons while the sidebar is hidden', async () => {
    await renderApp(
      fakeBridge({
        workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
        selectedId: 'w1',
      }),
    );
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'web' }), {
      key: 'ArrowDown',
      metaKey: true,
    });
    const header = () =>
      within(screen.getByRole('main'))
        .getByRole('region', { name: 'New session' })
        .querySelector('header');
    expect(header()?.className).toContain('pl-5');
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(header()?.className).toContain('pl-[84px]');
  });

  it('hides and shows the sidebar from its button as with ⌘B, opens it as the user left it, and gives the focus to the focused panel when it hides with the focus inside', async () => {
    const bridge = fakeBridge({
      workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
      selectedId: 'w1',
    });
    const set = vi.fn<Bridge['settings']['set']>(() => Promise.resolve());
    bridge.settings = { ...bridge.settings, set };
    await renderApp(bridge);
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const hide = within(sidebar).getByRole('button', { name: 'Hide Sidebar' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(hide.getAttribute('aria-controls')).toBe(sidebar.id);
    expect(hide.title).toBe('Hide Sidebar (⌘B)');
    fireEvent.click(hide);
    expect(sidebar.hasAttribute('inert')).toBe(true);
    const show = within(screen.getByRole('main')).getByRole('button', { name: 'Show Sidebar' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(show.title).toBe('Show Sidebar (⌘B)');
    expect(set).toHaveBeenLastCalledWith({ sidebarHidden: true });
    fireEvent.click(show);
    expect(sidebar.hasAttribute('inert')).toBe(false);
    expect(set).toHaveBeenLastCalledWith({ sidebarHidden: false });

    // With a panel open and the focus in the sidebar, hiding it gives the focus to the panel.
    fireEvent.click(within(sidebar).getByRole('button', { name: 'New session' }));
    within(sidebar).getByRole('button', { name: 'New session' }).focus();
    expect(sidebar.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('main').contains(document.activeElement)).toBe(true);
    expect(set).toHaveBeenLastCalledWith({ sidebarHidden: true });
    cleanup();

    // The window opens with the sidebar as the user last left it.
    const hidden = fakeBridge();
    hidden.settings = {
      ...hidden.settings,
      initial: { ...hidden.settings.initial, sidebarHidden: true },
    };
    await renderApp(hidden);
    expect(screen.getByRole('complementary', { name: 'Sidebar' }).hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('button', { name: 'Show Sidebar' })).toBeDefined();
  });

  it('opens a session page with New session, in the selected workspace or else the day’s folder', async () => {
    await renderApp(
      fakeBridge({
        workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
        selectedId: 'w1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const page = within(screen.getByRole('main')).getByRole('region', { name: 'New session' });
    expect(within(page).getByText('web').title).toBe('/Users/me/web');
    within(page).getByRole('textbox', { name: 'Message' });
    cleanup();
    await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session' }));
      await Promise.resolve();
    });
    const day = within(screen.getByRole('main')).getByRole('region', { name: 'New session' });
    expect(within(day).getByText('2026-10-28').title).toBe('/Users/me/3mukon-code/2026-10-28');
  });

  it('counts the sessions waiting on the user beside the window buttons, and shows the one that has waited longest', async () => {
    const waiting = (id: string, title: string, waitingSince: number) => ({
      id,
      provider: 'codex' as const,
      sessionId: `thread-${id}`,
      cwd: '/Users/me/web',
      title,
      status: 'waiting' as const,
      activeAt: 1,
      waitingSince,
    });
    await renderApp(
      fakeBridge({ workspaces: [], selectedId: null }, [
        waiting('s1', 'Fix the build', 300),
        waiting('s2', 'Update the docs', 100),
      ]),
    );
    const label = 'Sessions waiting on you: 2. Show the one waiting longest (⇧⌘A).';
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.click(within(sidebar).getByRole('button', { name: label }));
    within(screen.getByRole('main')).getByRole('region', { name: 'Update the docs' });
    // Just after the sidebar's button, the archived sessions' button and the settings' gear, which keep
    // their places beside the window buttons; with the sidebar hidden, all of them lie in the top-left
    // panel's header.
    const named = (element: Element | null | undefined) =>
      [...(element?.querySelectorAll('button') ?? [])].map((button) =>
        button.getAttribute('aria-label'),
      );
    expect(named(within(sidebar).getByRole('button', { name: label }).parentElement)).toEqual([
      'Hide Sidebar',
      'Archived sessions',
      'Accounts',
      'Settings',
      label,
    ]);
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    const header = within(screen.getByRole('main'))
      .getByRole('region', { name: 'Update the docs' })
      .querySelector('header');
    expect(named(header?.firstElementChild)).toEqual([
      'Show Sidebar',
      'Archived sessions',
      'Accounts',
      'Settings',
      label,
    ]);
  });

  it('shows a session waiting on an operation’s approval with the focus on that approval', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Read my invoices',
        status: 'waiting',
        activeAt: 1,
        waitingSince: 2,
      },
    ]);
    const tab: TargetSummary = {
      ref: { id: 't1', kind: 'browser-tab', generation: 1 },
      owner: 's1',
      name: 'Billing',
      address: 'https://acme.test/billing',
      sharing: 'app',
      browser: 'embedded',
    };
    const automation = new FakeAutomationBridge();
    automation.seed({
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'waiting-grant',
      resources: [tab],
      operations: [],
      grants: [],
      pendingApprovals: [
        {
          id: 'host:1',
          callId: 'call-1',
          source: 'host',
          operation: {
            id: 'op-1',
            owner: 's1',
            turn: 'turn-1',
            accessGeneration: 1,
            target: tab.ref,
            kind: 'browser-tab',
            policyEpoch: 1,
            state: 'waiting',
            targetMayActivate: false,
            deadline: null,
          },
          target: tab,
          canAllowForSession: true,
          requestedAt: 2,
        },
      ],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'supported' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [],
    });
    bridge.automation = automation;
    await renderApp(bridge);
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.click(
      within(sidebar).getByRole('button', {
        name: 'Sessions waiting on you: 1. Show the one waiting longest (⇧⌘A).',
      }),
    );
    const block = await within(screen.getByRole('main')).findByRole('region', {
      name: 'Work on acme.test in the app’s browser, signed in?',
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(block);
    });
  });

  it('lists archived sessions apart, in a panel the button beside the window buttons opens, which shows one and acts on it', async () => {
    const summary = (id: string, title: string, archived: boolean): SessionSummary => ({
      id,
      provider: 'codex',
      sessionId: `thread-${id}`,
      cwd: '/Users/me/web',
      title,
      status: 'closed',
      activeAt: 1,
      ...(archived ? { archived: true } : {}),
    });
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      summary('s1', 'Fix the build', false),
      summary('s2', 'Old idea', true),
    ]);
    const act = vi.fn<Bridge['sessions']['act']>(() => Promise.resolve('unarchive'));
    bridge.sessions.act = act;
    await renderApp(bridge);
    const sessions = screen.getByRole('region', { name: 'Sessions' });
    within(sessions).getByText('Fix the build');
    expect(within(sessions).queryByText('Old idea')).toBeNull();
    const main = screen.getByRole('main');
    const button = screen.getByRole('button', { name: 'Archived sessions' });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    const archived = within(main).getByRole('region', { name: 'Archived sessions' });
    expect(within(archived).getByText('1 session')).toBeTruthy();
    // A second click focuses the same panel.
    fireEvent.click(button);
    expect(within(main).getAllByRole('region', { name: 'Archived sessions' })).toHaveLength(1);
    // A session clicked there opens in a panel titled by it, whose page has its provider, though the
    // Sessions list lacks it.
    fireEvent.click(await within(archived).findByRole('button', { name: /Old idea/ }));
    const panel = within(main).getByRole('region', { name: 'Old idea' });
    await waitFor(() => {
      expect(within(panel).getByText('Codex CLI')).toBeTruthy();
    });
    // Its row unarchives it without its menu.
    fireEvent.click(within(archived).getByRole('button', { name: 'Unarchive' }));
    expect(act.mock.calls).toEqual([['s2', 'unarchive']]);
  });

  it('leaves a notice under a call refused until something is set up, whose step goes to main only from its click', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Reply to invoices',
        status: 'idle',
        activeAt: 1,
      },
    ]);
    bridge.sessions.snapshot = () =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          timeline: [
            {
              type: 'tool',
              id: 'tool-1',
              kind: 'other',
              title: 'computer_observe',
              status: 'failed',
              output: '',
              changes: [],
            },
          ],
        },
      });
    const automation = new FakeAutomationBridge();
    automation.seed({
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'idle',
      resources: [],
      operations: [],
      grants: [],
      pendingApprovals: [],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'supported' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [
        {
          callId: 'call-1',
          sessionId: 's1',
          turnId: 'turn-1',
          accessGeneration: 1,
          revision: 1,
          toolName: 'computer_observe',
          operationId: null,
          operationEnd: null,
          grantId: null,
          grantEnd: null,
          approval: null,
          incidents: [],
          startedAt: 1,
          completedAt: 2,
          phase: 'settled',
          outcome: {
            status: 'refused',
            code: 'setup-required',
            dispatched: false,
            detail: {
              kind: 'setup',
              requirement: { kind: 'permission', permission: 'screen-recording' },
            },
          },
          frames: [],
          framesState: 'available',
          providerEntry: {
            callId: 'call-1',
            sessionId: 's1',
            turnId: 'turn-1',
            accessGeneration: 1,
            toolName: 'computer_observe',
            providerToolId: 'tool-1',
          },
          family: 'computer',
          target: {
            state: 'resolved',
            summary: {
              ref: { id: 'app-1', kind: 'application', generation: 1 },
              owner: 's1',
              name: 'Mail',
            },
          },
          sharing: null,
          delivery: 'background',
        },
      ],
    });
    bridge.automation = automation;
    const setup = new FakeUserSetupBridge(NO_SETUP);
    setup.outcome = { status: 'verified', value: null };
    bridge.setup = setup;
    await renderApp(bridge);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Reply to invoices/,
      }),
    );
    const panel = within(screen.getByRole('main')).getByRole('region', {
      name: 'Reply to invoices',
    });
    await waitFor(() => {
      expect(within(panel).getByText('Computer use needs Screen Recording')).toBeTruthy();
    });
    expect(within(panel).getByText('Needs setup')).toBeTruthy();
    expect(setup.commands).toEqual([]);
    fireEvent.click(within(panel).getByRole('button', { name: 'Open System Settings' }));
    await waitFor(() => {
      expect(setup.commands).toEqual([{ kind: 'open-permission', permission: 'screen-recording' }]);
    });
  });

  it('leaves a notice that browser use needs Chrome connected, whose Connect connects its profile from the click', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Read my invoices',
        status: 'idle',
        activeAt: 1,
      },
    ]);
    bridge.sessions.snapshot = () =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          timeline: [
            {
              type: 'tool',
              id: 'tool-1',
              kind: 'other',
              title: 'browser_open',
              status: 'failed',
              output: '',
              changes: [],
            },
          ],
        },
      });
    const automation = new FakeAutomationBridge();
    automation.seed({
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'idle',
      resources: [],
      operations: [],
      grants: [],
      pendingApprovals: [],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'supported' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [
        {
          callId: 'call-1',
          sessionId: 's1',
          turnId: 'turn-1',
          accessGeneration: 1,
          revision: 1,
          toolName: 'browser_open',
          operationId: null,
          operationEnd: null,
          grantId: null,
          grantEnd: null,
          approval: null,
          incidents: [],
          startedAt: 1,
          completedAt: 2,
          phase: 'settled',
          outcome: {
            status: 'refused',
            code: 'setup-required',
            dispatched: false,
            detail: {
              kind: 'setup',
              requirement: { kind: 'browser', browser: 'chrome', step: 'connect' },
            },
          },
          frames: [],
          framesState: 'available',
          providerEntry: {
            callId: 'call-1',
            sessionId: 's1',
            turnId: 'turn-1',
            accessGeneration: 1,
            toolName: 'browser_open',
            providerToolId: 'tool-1',
          },
          family: 'browser',
          target: { state: 'unresolved' },
          sharing: 'global',
          delivery: 'background',
        },
      ],
    });
    bridge.automation = automation;
    const chrome: SetupSnapshot['chrome'] = {
      ...NO_SETUP.chrome,
      installedVersion: '158.0.8127.18',
      minimumVersion: '158.0.8127.2',
      connection: 'disconnected',
      profiles: [{ id: 'Default', name: 'Personal' }],
    };
    const setup = new FakeUserSetupBridge({ ...NO_SETUP, chrome });
    setup.outcome = { status: 'verified', value: null };
    bridge.setup = setup;
    await renderApp(bridge);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Read my invoices/,
      }),
    );
    const panel = within(screen.getByRole('main')).getByRole('region', {
      name: 'Read my invoices',
    });
    await waitFor(() => {
      expect(within(panel).getByText('Browser use needs Chrome connected')).toBeTruthy();
    });
    expect(setup.commands).toEqual([]);
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(setup.commands).toEqual([
        { kind: 'connect-browser', browser: 'chrome', profileId: 'Default' },
      ]);
    });
    act(() => {
      setup.publish({
        ...NO_SETUP,
        chrome: {
          ...chrome,
          connection: 'connected',
          profile: { id: 'Default', name: 'Personal' },
        },
      });
    });
    expect(within(panel).getByText('Connected')).toBeTruthy();
    expect(within(panel).getByText('Personal profile, with its sign-ins')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(within(panel).queryByText(/choose the tab/i)).toBeNull();
  });

  it('asks for an operation’s approval at the end of the activity, lists the grants above the composer and ends them, and keeps the answered approval before its call', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Read my invoices',
        status: 'running',
        activeAt: 1,
      },
    ]);
    bridge.sessions.snapshot = () =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          turnRunning: true,
          timeline: [
            {
              type: 'tool',
              id: 'tool-1',
              kind: 'other',
              title: 'browser_navigate',
              status: 'completed',
              output: '',
              changes: [],
            },
          ],
        },
      });
    const tab: TargetSummary = {
      ref: { id: 't1', kind: 'browser-tab', generation: 1 },
      owner: 's1',
      name: 'Inbox',
      address: 'https://mail.example.com/inbox',
      sharing: 'global',
      browser: 'chrome',
      profile: { id: 'Default', name: 'Personal' },
    };
    const operation = {
      owner: 's1',
      turn: 'turn-1',
      accessGeneration: 1,
      target: tab.ref,
      kind: 'browser-tab' as const,
      policyEpoch: 1,
      targetMayActivate: true,
      deadline: 0,
    };
    const asked: HostApproval = {
      id: 'host:2',
      callId: 'call-2',
      source: 'host',
      operation: { ...operation, id: 'op-2', state: 'waiting' },
      target: tab,
      canAllowForSession: true,
      requestedAt: 2,
    };
    const automation = new FakeAutomationBridge();
    automation.seed({
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'waiting-grant',
      resources: [tab],
      operations: [],
      grants: [
        {
          id: 'g1',
          target: tab,
          summaryAt: 1,
          operationKind: 'browser-tab',
          scope: 'session',
          issuedAt: 1,
        },
      ],
      pendingApprovals: [asked],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'supported' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [
        {
          callId: 'call-1',
          sessionId: 's1',
          turnId: 'turn-1',
          accessGeneration: 1,
          revision: 1,
          toolName: 'browser_navigate',
          operationId: 'op-1',
          operationEnd: null,
          grantId: 'g1',
          grantEnd: null,
          approval: {
            request: {
              ...asked,
              id: 'host:1',
              callId: 'call-1',
              operation: { ...operation, id: 'op-1', state: 'active' },
            },
            answer: { decision: 'allow-for-session' },
            answeredAt: 1,
            grantId: 'g1',
          },
          incidents: [],
          startedAt: 1,
          completedAt: 2,
          phase: 'settled',
          outcome: { status: 'dispatched', evidence: 'not-verified' },
          frames: [],
          framesState: 'available',
          providerEntry: {
            callId: 'call-1',
            sessionId: 's1',
            turnId: 'turn-1',
            accessGeneration: 1,
            toolName: 'browser_navigate',
            providerToolId: 'tool-1',
          },
          family: 'browser',
          target: { state: 'resolved', summary: tab },
          sharing: 'global',
          delivery: 'background',
        },
      ],
    });
    automation.outcome = { status: 'verified', value: null };
    bridge.automation = automation;
    await renderApp(bridge);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Read my invoices/,
      }),
    );
    const panel = within(screen.getByRole('main')).getByRole('region', {
      name: 'Read my invoices',
    });
    const block = await within(panel).findByRole('region', {
      name: 'Work on mail.example.com in Chrome, signed in as you?',
    });
    within(block).getByText(
      'Codex CLI wants to use the Personal profile’s sign-ins, in a tab it opens in Chrome.',
    );
    fireEvent.click(within(block).getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => {
      expect(automation.commands).toContainEqual({
        kind: 'answer',
        sessionId: 's1',
        id: 'host:2',
        answer: { decision: 'allow-once' },
      });
    });

    const answered = within(panel).getByText('Allowed for this session');
    const call = within(panel).getByText('Opened');
    expect(answered.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const line = answered.closest('p');
    if (line === null) throw new Error('The answered approval has no line.');
    fireEvent.click(
      within(line).getByRole('button', {
        name: 'End: Work on mail.example.com in Chrome, signed in as you?',
      }),
    );
    await waitFor(() => {
      expect(automation.commands).toContainEqual({ kind: 'end-grant', sessionId: 's1', id: 'g1' });
    });

    within(panel).getByText('1 grant');
    within(panel).getByText(/· Chrome tab mail\.example\.com$/);
  });

  it('reads setup automatically while Settings is open and takes setup actions from clicks', async () => {
    const bridge = fakeBridge();
    const setup = new FakeUserSetupBridge({
      ...NO_SETUP,
      computer: { ...NO_SETUP.computer, accessibility: 'granted', screenRecording: 'not-granted' },
    });
    setup.outcome = { status: 'verified', value: null };
    const read = vi.spyOn(setup, 'snapshot');
    bridge.setup = setup;
    await renderApp(bridge);
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const main = within(screen.getByRole('main'));
    await waitFor(() => {
      expect(main.getByText('Allowed')).toBeTruthy();
    });
    expect(main.getByRole('region', { name: 'Browser use' })).toBeTruthy();
    expect(read).toHaveBeenCalledOnce();
    expect(setup.commands).toEqual([]);
    expect(main.queryByRole('button', { name: 'Check Permissions' })).toBeNull();
    fireEvent.click(main.getByRole('button', { name: 'Clear Sign-Ins' }));
    fireEvent.click(main.getByRole('button', { name: 'Open System Settings' }));
    await waitFor(() => {
      expect(setup.commands).toEqual([
        { kind: 'clear-app-sign-ins' },
        { kind: 'open-permission', permission: 'screen-recording' },
      ]);
    });
    // A permission update can reach the panel ahead of an older reply to its focus read.
    const cached = await setup.snapshot();
    read.mockClear();
    let reply!: (snapshot: SetupSnapshot) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    fireEvent.focus(window);
    expect(read).toHaveBeenCalledOnce();
    act(() => {
      setup.publish({ ...cached, computer: { ...cached.computer, screenRecording: 'granted' } });
    });
    await act(async () => {
      reply(cached);
      await Promise.resolve();
    });
    expect(main.getAllByText('Allowed')).toHaveLength(2);
    expect(main.queryByRole('button', { name: 'Open System Settings' })).toBeNull();
  });

  it('opens the settings in a panel of their own with the gear or ⌘,, and the window takes the language they choose', async () => {
    const bridge = fakeBridge();
    let current: AppSettings = {
      language: 'system',
      appearance: 'system',
      tooltips: false,
      sidebarHidden: false,
    };
    const listeners = new Set<(settings: AppSettings) => void>();
    const set = vi.fn<Bridge['settings']['set']>((change) => {
      current = { ...current, ...change };
      for (const listener of listeners) listener(current);
      return Promise.resolve();
    });
    bridge.settings = {
      initial: current,
      get: () => Promise.resolve(current),
      set,
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    await renderApp(bridge);
    const main = screen.getByRole('main');
    const gear = screen.getByRole('button', { name: 'Settings' });
    // The gear lies just after the archived sessions' button and the accounts' gauge, beside the
    // window buttons.
    const gauge = screen.getByRole('button', { name: 'Accounts' });
    expect(screen.getByRole('button', { name: 'Archived sessions' }).nextElementSibling).toBe(
      gauge,
    );
    expect(gauge.nextElementSibling).toBe(gear);
    fireEvent.click(gear);
    const settings = within(main).getByRole('region', { name: 'Settings' });
    expect(fireEvent.keyDown(window, { key: ',', metaKey: true })).toBe(false);
    expect(within(main).getAllByRole('region', { name: 'Settings' })).toHaveLength(1);
    const language = within(settings).getByRole('radiogroup', { name: 'Language' });
    within(language).getByRole('radio', { name: 'System', checked: true });
    // Choosing Simplified Chinese changes the window's language at once.
    await act(async () => {
      fireEvent.click(within(language).getByRole('radio', { name: '简体中文' }));
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledWith({ language: 'zh-Hans' });
    await waitFor(() => {
      expect(screen.getByRole('region', { name: '会话' })).toBeTruthy();
    });
    expect(document.documentElement.lang).toBe('zh-Hans');
    await act(async () => {
      fireEvent.click(within(main).getByRole('radio', { name: 'English' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Sessions' })).toBeTruthy();
    });
  });

  it('keeps titling the panel of a session archived while it shows, from the sessions the window has shown', async () => {
    const bridge = fakeBridge();
    const summary: SessionSummary = {
      id: 's1',
      provider: 'codex',
      sessionId: 'thread-1',
      cwd: '/Users/me/web',
      title: 'Fix the build',
      status: 'idle',
      activeAt: 1,
    };
    let report: (list: SessionList) => void = () => undefined;
    bridge.sessions.onChange = (listener) => {
      report = listener;
      return () => undefined;
    };
    await renderApp(bridge);
    act(() => {
      report({ sessions: [summary], archived: 0, shown: [] });
    });
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      }),
    );
    act(() => {
      report({
        sessions: [],
        archived: 1,
        shown: [{ ...summary, status: 'closed', archived: true }],
      });
    });
    const panel = within(screen.getByRole('main')).getByRole('region', { name: 'Fix the build' });
    expect(within(panel).getByText('Codex CLI')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archived sessions' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('offers a session’s menu, and closes the panels of a session removed from the lists', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Fix the build',
        status: 'idle',
        activeAt: 1,
      },
    ]);
    const asked: string[] = [];
    let done: 'archive' | 'remove' | null = 'archive';
    bridge.sessions.showMenu = (id) => {
      asked.push(id);
      return Promise.resolve(done);
    };
    await renderApp(bridge);
    const row = () =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      });
    fireEvent.click(row());
    const shown = () =>
      within(screen.getByRole('main')).queryAllByRole('region', { name: 'Fix the build' });
    expect(shown()).toHaveLength(1);
    // Archived, a session keeps its panel; removed, it loses it.
    await act(async () => {
      fireEvent.contextMenu(row());
      await Promise.resolve();
    });
    expect(shown()).toHaveLength(1);
    done = 'remove';
    await act(async () => {
      fireEvent.contextMenu(row());
      await Promise.resolve();
    });
    expect(asked).toEqual(['s1', 's1']);
    expect(shown()).toHaveLength(0);
  });

  it('shows the request that has waited longest with ⇧⌘A, with the focus on it, and the next waiting session’s at the next press', async () => {
    const waiting = (id: string, title: string, waitingSince: number): SessionSummary => ({
      id,
      provider: 'codex',
      sessionId: `thread-${id}`,
      cwd: '/Users/me/web',
      title,
      status: 'waiting',
      activeAt: 1,
      waitingSince,
    });
    const since: Record<string, number> = { s1: 300, s2: 100 };
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      waiting('s1', 'Fix the build', 300),
      waiting('s2', 'Update the docs', 100),
    ]);
    bridge.sessions.snapshot = (id) =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          turnRunning: true,
          timeline: [
            {
              type: 'approval',
              request: {
                id: `r-${id}`,
                action: 'command',
                command: `run ${id}`,
                canAllowForSession: false,
                denyByDefault: false,
                requestedAt: since[id] ?? 0,
              },
            },
          ],
        },
      });
    await renderApp(bridge);
    const press = () =>
      act(async () => {
        fireEvent.keyDown(window, { key: 'A', metaKey: true, shiftKey: true });
        await Promise.resolve();
      });
    const focusedIn = (title: string) =>
      within(screen.getByRole('main'))
        .getByRole('region', { name: title })
        .contains(document.activeElement);
    await press();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Run this command?');
    });
    expect(focusedIn('Update the docs')).toBe(true);
    await press();
    await waitFor(() => {
      expect(focusedIn('Fix the build')).toBe(true);
    });
    expect(document.activeElement?.textContent).toContain('run s1');
  });

  it('gives the focus to the waiting request in the first of the panels that show its session', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Fix the build',
        status: 'waiting',
        activeAt: 1,
        waitingSince: 100,
      },
    ]);
    bridge.sessions.snapshot = () =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          turnRunning: true,
          timeline: [
            {
              type: 'approval',
              request: {
                id: 'r1',
                action: 'command',
                command: 'run s1',
                canAllowForSession: false,
                denyByDefault: false,
                requestedAt: 100,
              },
            },
          ],
        },
      });
    await renderApp(bridge);
    // happy-dom lays nothing out, so the main area and each panel in it measure 1000 by 600 pixels.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });
    const row = () =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      });
    for (const clientX of [500, 990]) {
      fireEvent.pointerDown(row(), { pointerId: 1, button: 0, clientX: -100, clientY: 20 });
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX, clientY: 300 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX, clientY: 300 });
      fireEvent.click(row());
      await dropped();
    }
    const [first, second] = within(screen.getByRole('main')).getAllByRole('region', {
      name: 'Fix the build',
    });
    await waitFor(() => {
      expect(second?.textContent).toContain('run s1');
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'A', metaKey: true, shiftKey: true });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Run this command?');
    });
    expect(first?.contains(document.activeElement)).toBe(true);
    expect(first?.getAttribute('aria-current')).toBe('true');
  });

  it('shows a session clicked in the list in a panel of its own, titled by the session', async () => {
    await renderApp(
      fakeBridge({ workspaces: [], selectedId: null }, [
        {
          id: 's1',
          provider: 'codex',
          sessionId: 'thread-1',
          cwd: '/Users/me/web',
          title: 'Fix the build',
          status: 'running',
          activeAt: 1,
        },
      ]),
    );
    const row = () =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      });
    fireEvent.click(row());
    const panel = within(screen.getByRole('main')).getByRole('region', { name: 'Fix the build' });
    expect(panel.textContent).toContain('Running');
    // A second click shows the same panel.
    fireEvent.click(row());
    expect(
      within(screen.getByRole('main')).getAllByRole('region', { name: 'Fix the build' }),
    ).toHaveLength(1);
  });

  it('drags sessions from the list into the panel area, one into several panels as files go, and has the history of one that is not running read ahead', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Fix the build',
        status: 'closed',
        activeAt: 2,
      },
      {
        id: 's2',
        provider: 'claude-code',
        sessionId: 'p2',
        cwd: '/Users/me/web',
        title: 'Write the docs',
        status: 'running',
        activeAt: 1,
      },
    ]);
    const preload = vi.fn<Bridge['sessions']['preload']>(() => Promise.resolve());
    bridge.sessions.preload = preload;
    await renderApp(bridge);
    // happy-dom lays nothing out, so the main area and each panel in it measure 1000 by 600 pixels.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });
    const row = (name: RegExp) =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', { name });
    // A press on a row in the sidebar, dragged to a point in the main area and let go there, with the
    // click the browser gives the release, until the session has opened.
    const dragIn = async (name: RegExp, clientX: number, clientY: number) => {
      fireEvent.pointerDown(row(name), { pointerId: 1, button: 0, clientX: -100, clientY: 20 });
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX, clientY });
      fireEvent.pointerUp(window, { pointerId: 1, clientX, clientY });
      fireEvent.click(row(name));
      await dropped();
    };

    // A press reads the history at once; a running session has none to read.
    for (const name of [/Write the docs/, /Fix the build/]) {
      fireEvent.pointerDown(row(name), { pointerId: 1, button: 0 });
      fireEvent.pointerUp(window, { pointerId: 1 });
    }
    expect(preload.mock.calls).toEqual([['s1']]);

    // Dragged to the empty area, a session fills it; near its panel's edge, it opens again beside it,
    // and the release's click does not show the first.
    expect(row(/Fix the build/).hasAttribute('draggable')).toBe(false);
    await dragIn(/Fix the build/, 500, 300);
    const main = screen.getByRole('main');
    within(main).getByRole('region', { name: 'Fix the build' });
    await dragIn(/Fix the build/, 990, 300);
    const panels = within(main).getAllByRole('region', { name: 'Fix the build' });
    expect(panels.map((panel) => panel.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('hides the sidebar with Command-B and shows it again', async () => {
    await renderApp();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(false);
  });

  it('leaves B without Command, or with another modifier, alone', async () => {
    await renderApp();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'b', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'b', metaKey: true, altKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(false);
  });

  it('records a presentation under the tool call that made it, whose Show asks main and says why it could not show it', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Compare pricing pages',
        status: 'idle',
        activeAt: 1,
      },
    ]);
    bridge.sessions.snapshot = () =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          timeline: [
            {
              type: 'tool',
              id: 'tool-1',
              kind: 'other',
              title: 'panel_present',
              status: 'completed',
              output: '',
              changes: [],
            },
          ],
        },
      });
    const automation = new FakeAutomationBridge();
    const snapshot: AutomationSnapshot = {
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'idle',
      resources: [],
      operations: [],
      grants: [],
      pendingApprovals: [],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'unknown' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [
        {
          callId: 'call-1',
          sessionId: 's1',
          turnId: 'turn-1',
          accessGeneration: 1,
          revision: 2,
          toolName: 'panel_present',
          operationId: null,
          operationEnd: null,
          grantId: null,
          grantEnd: null,
          approval: null,
          incidents: [],
          startedAt: 1,
          completedAt: 2,
          phase: 'settled',
          outcome: { status: 'verified', value: null },
          frames: [],
          framesState: 'available',
          providerEntry: {
            callId: 'call-1',
            sessionId: 's1',
            turnId: 'turn-1',
            accessGeneration: 1,
            toolName: 'panel_present',
            providerToolId: 'tool-1',
          },
          family: 'panel',
          presentations: [
            {
              id: 'p1',
              title: 'comparison.md',
              version: 2,
              items: [{ content: { kind: 'artifact', artifactId: 'a1' }, box: null }],
            },
          ],
        },
      ],
    };
    automation.seed(snapshot);
    bridge.automation = automation;
    let deliver: ((message: PresentationHostMessage) => void) | undefined;
    const sent: PresentationRendererMessage[] = [];
    bridge.presentations = {
      onMessage: (listener) => {
        deliver = listener;
        return () => {
          deliver = undefined;
        };
      },
      send: (message) => {
        sent.push(message);
      },
      artifact: () => Promise.resolve(null),
    };
    await renderApp(bridge);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Compare pricing pages/,
      }),
    );
    const panel = within(screen.getByRole('main')).getByRole('region', {
      name: 'Compare pricing pages',
    });
    await waitFor(() => {
      expect(within(panel).getByText('Showed comparison.md beside this session')).toBeTruthy();
    });
    // The presentation's line stands in the provider's entry's place.
    expect(within(panel).queryByText('panel_present')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    const request = sent.at(-1);
    if (request?.kind !== 'show' || !('presentationId' in request)) {
      throw new Error('The window asked main for nothing.');
    }
    expect(request).toMatchObject({ owner: 's1', presentationId: 'p1' });
    act(() => {
      deliver?.({
        kind: 'show-answer',
        epoch: request.epoch,
        requestId: request.requestId,
        outcome: 'expired',
      });
    });
    await waitFor(() => {
      expect(within(panel).getByText('It’s no longer available.')).toBeTruthy();
    });
  });

  it('shows a browser call in place of its tool call, and what the session uses above its composer, with Show and Stop', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Compare pricing pages',
        status: 'running',
        activeAt: 1,
      },
    ]);
    bridge.sessions.snapshot = () =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          timeline: [
            {
              type: 'tool',
              id: 'tool-1',
              kind: 'other',
              title: 'browser_navigate',
              status: 'completed',
              output: '',
              changes: [],
            },
          ],
        },
      });
    const tab = {
      ref: { id: 'tab-1', kind: 'browser-tab' as const, generation: 1 },
      owner: 's1',
      name: 'Pricing · Example',
      address: 'https://example.com/pricing',
      sharing: 'none' as const,
      browser: 'embedded' as const,
    };
    const automation = new FakeAutomationBridge();
    automation.seed({
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'acting',
      resources: [tab],
      operations: [
        {
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
        },
      ],
      grants: [],
      pendingApprovals: [],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'supported' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [
        {
          callId: 'call-1',
          sessionId: 's1',
          turnId: 'turn-1',
          accessGeneration: 1,
          revision: 1,
          toolName: 'browser_navigate',
          operationId: 'op-1',
          operationEnd: null,
          grantId: null,
          grantEnd: null,
          approval: null,
          incidents: [],
          startedAt: 1,
          completedAt: 2,
          phase: 'settled',
          outcome: { status: 'verified', value: null },
          frames: [],
          framesState: 'available',
          providerEntry: {
            callId: 'call-1',
            sessionId: 's1',
            turnId: 'turn-1',
            accessGeneration: 1,
            toolName: 'browser_navigate',
            providerToolId: 'tool-1',
          },
          family: 'browser',
          target: { state: 'resolved', summary: tab },
          sharing: 'none',
          delivery: 'background',
        },
      ],
    });
    bridge.automation = automation;
    const sent: PresentationRendererMessage[] = [];
    bridge.presentations = {
      onMessage: () => () => undefined,
      send: (message) => {
        sent.push(message);
      },
      artifact: () => Promise.resolve(null),
    };
    await renderApp(bridge);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Compare pricing pages/,
      }),
    );
    const panel = within(screen.getByRole('main')).getByRole('region', {
      name: 'Compare pricing pages',
    });
    await waitFor(() => {
      expect(within(panel).getByText(textOf('Opened example.com/pricing'))).toBeTruthy();
    });
    expect(within(panel).queryByText('browser_navigate')).toBeNull();
    expect(
      within(panel).getByText(textOf('Using example.com · No sharing · in the background')),
    ).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    const request = sent.at(-1);
    if (request?.kind !== 'show' || !('content' in request)) {
      throw new Error('The window asked main to show nothing.');
    }
    expect(request).toMatchObject({ owner: 's1', content: { kind: 'browser', tabId: 'tab-1' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(automation.commands).toContainEqual({ kind: 'stop', sessionId: 's1' });
    });
  });

  it('shows a tab its session presents as its live page, in a panel named by the page, with its sharing and what the session does with it', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Compare pricing pages',
        status: 'running',
        activeAt: 1,
      },
    ]);
    const ref = { id: 'tab-1', kind: 'browser-tab' as const, generation: 1 };
    const automation = new FakeAutomationBridge();
    automation.seed({
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'acting',
      resources: [
        {
          ref,
          owner: 's1',
          name: 'Pricing · Example',
          address: 'https://example.com/pricing',
          sharing: 'none',
          browser: 'embedded',
        },
      ],
      operations: [
        {
          id: 'op-1',
          owner: 's1',
          turn: 'turn-1',
          accessGeneration: 1,
          target: ref,
          kind: 'browser-tab',
          policyEpoch: 1,
          state: 'active',
          targetMayActivate: false,
          deadline: 0,
        },
      ],
      grants: [],
      pendingApprovals: [],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'supported' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [],
    });
    bridge.automation = automation;
    const tabs = new FakeBrowserTabs();
    tabs.show({
      ref,
      owner: 's1',
      browser: 'embedded',
      sharing: 'none',
      profile: null,
      title: 'Pricing · Example',
      address: 'https://example.com/pricing',
      documentGeneration: 1,
      geometryGeneration: 1,
      loading: false,
      error: null,
      signIn: 'unknown',
      canGoBack: true,
      canGoForward: false,
      control: 'agent',
    });
    const placements: BrowserViewPlacement[] = [];
    let focused: ((binding: string) => void) | undefined;
    const bind = vi.fn(() => Promise.resolve({ status: 'verified' as const, value: 'b1' }));
    bridge.browser = {
      tabRef: (owner, id) => Promise.resolve(owner === 's1' && id === 'tab-1' ? ref : null),
      snapshot: tabs.snapshot.bind(tabs),
      command: tabs.command.bind(tabs),
      subscribe: tabs.subscribe.bind(tabs),
      bind,
      place: (_binding, _revision, placement) => {
        placements.push(placement);
        return Promise.resolve({ status: 'verified', value: { kind: 'live' } });
      },
      release: () => Promise.resolve(),
      onFocus: (listener) => {
        focused = listener;
        return () => {
          focused = undefined;
        };
      },
      onFileDrag: () => () => undefined,
    };
    let deliver: ((message: PresentationHostMessage) => void) | undefined;
    const sent: PresentationRendererMessage[] = [];
    bridge.presentations = {
      onMessage: (listener) => {
        deliver = listener;
        return () => {
          deliver = undefined;
        };
      },
      send: (message) => {
        sent.push(message);
      },
      artifact: () => Promise.resolve(null),
    };
    await renderApp(bridge);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Compare pricing pages/,
      }),
    );
    const epoch = sent.find((message) => message.kind === 'snapshot')?.epoch ?? '';
    act(() => {
      deliver?.({
        kind: 'present',
        commandId: 'c1',
        epoch,
        owner: 's1',
        presentationId: 'p1',
        version: 0,
        title: 'Pricing · Example',
        items: [{ kind: 'browser', tabId: 'tab-1' }],
        placement: { side: 'right', direction: 'row' },
      });
    });
    const browser = await waitFor(() =>
      within(screen.getByRole('main')).getByRole('region', { name: 'Pricing · Example' }),
    );
    await waitFor(() => {
      expect(within(browser).getByText('example.com/pricing')).toBeTruthy();
    });
    // The header names the page by its title and host, with how it is shared.
    expect(within(browser).getByText('example.com')).toBeTruthy();
    expect(within(browser).getByText('No sharing')).toBeTruthy();
    expect(within(browser).getByText('Compare pricing pages is acting')).toBeTruthy();
    await waitFor(() => {
      expect(bind).toHaveBeenCalledWith('s1', 'p1', ref);
    });
    // Presented without the focus, the page dims; the click main reports focuses its panel.
    await waitFor(() => {
      expect(placements.at(-1)?.dim).not.toBeNull();
    });
    act(() => {
      focused?.('b1');
    });
    await waitFor(() => {
      expect(placements.at(-1)?.dim).toBeNull();
    });
    fireEvent.click(within(browser).getByRole('button', { name: 'Back' }));
    await waitFor(() => {
      expect(tabs.commands).toContainEqual({ kind: 'back' });
    });
    fireEvent.click(within(browser).getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(automation.commands).toContainEqual({ kind: 'stop', sessionId: 's1' });
    });
  });

  it('shows a window its session presents as a preview named by its application, with Switch to and what the session does with it', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/notes',
        title: 'Reply to invoices',
        status: 'running',
        activeAt: 1,
      },
    ]);
    const app = { id: 'app-1', kind: 'application' as const, generation: 1 };
    const window = { id: 'window-1', kind: 'window' as const, generation: 1 };
    const automation = new FakeAutomationBridge();
    automation.seed({
      sessionId: 's1',
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      policyEpoch: 1,
      phase: 'acting',
      resources: [
        { ref: { ...app, id: 'other-app', generation: 2 }, owner: 's1', name: 'Mail' },
        { ref: app, owner: 's1', name: 'Mail' },
        { ref: window, owner: 's1', name: 'Inbox', applicationName: 'Mail', application: app },
      ],
      operations: [
        {
          id: 'op-1',
          owner: 's1',
          turn: 'turn-1',
          accessGeneration: 1,
          target: app,
          kind: 'application-background',
          policyEpoch: 1,
          state: 'active',
          targetMayActivate: true,
          deadline: 0,
        },
      ],
      grants: [],
      pendingApprovals: [],
      foregroundOwner: null,
      availability: { tools: 'ready', images: 'supported' },
      endedGrants: [],
      presentationNotices: [],
      recentCalls: [],
    });
    bridge.automation = automation;
    const preview = vi.fn(() =>
      Promise.resolve({
        status: 'verified' as const,
        value: { status: 'unavailable' as const, reason: 'permission-required' as const },
      }),
    );
    const command = vi.fn(() => Promise.resolve({ status: 'verified' as const, value: null }));
    bridge.computer = { preview, command };
    const setup = new FakeUserSetupBridge(NO_SETUP);
    bridge.setup = setup;
    let deliver: ((message: PresentationHostMessage) => void) | undefined;
    const sent: PresentationRendererMessage[] = [];
    bridge.presentations = {
      onMessage: (listener) => {
        deliver = listener;
        return () => {
          deliver = undefined;
        };
      },
      send: (message) => {
        sent.push(message);
      },
      artifact: () => Promise.resolve(null),
    };
    await renderApp(bridge);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Reply to invoices/,
      }),
    );
    const epoch = sent.find((message) => message.kind === 'snapshot')?.epoch ?? '';
    act(() => {
      deliver?.({
        kind: 'present',
        commandId: 'c1',
        epoch,
        owner: 's1',
        presentationId: 'p1',
        version: 0,
        title: 'Inbox',
        items: [{ kind: 'computer', targetId: 'window-1' }],
        placement: { side: 'right', direction: 'row' },
      });
    });
    const panel = await waitFor(() =>
      within(screen.getByRole('main')).getByRole('region', { name: 'Mail' }),
    );
    // The header names the application and the session, with whether the work runs in the background.
    expect(within(panel).getByText('Reply to invoices')).toBeTruthy();
    expect(within(panel).getByText('Background')).toBeTruthy();
    await waitFor(() => {
      expect(preview).toHaveBeenCalledWith('s1', 'p1', 'window-1');
    });
    await waitFor(() => {
      expect(within(panel).getByText('Showing Mail needs Screen Recording')).toBeTruthy();
    });
    expect(within(panel).getByText('Reply to invoices is acting in Mail')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Open System Settings' }));
    await waitFor(() => {
      expect(setup.commands).toContainEqual({
        kind: 'open-permission',
        permission: 'screen-recording',
      });
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Switch to Mail' }));
    await waitFor(() => {
      expect(command).toHaveBeenCalledWith('s1', 'p1', 'window-1', 'reveal');
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(automation.commands).toContainEqual({ kind: 'stop', sessionId: 's1' });
    });
  });
});
