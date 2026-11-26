import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { AccountsBridge, ProviderAccount } from '../shared/accounts';
import { AccountsButton, AccountsPanel } from './accounts-panel';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
});

const now = Date.now();
const accounts: ProviderAccount[] = [
  {
    provider: 'claude-code',
    signIn: { state: 'signed-in', method: 'subscription' },
    usage: {
      windows: [
        { span: 'five-hour', used: 84, resetsAt: now + 60_000 },
        { span: 'week', model: 'Opus', used: null, resetsAt: null },
      ],
      readAt: now - 3 * 60_000,
    },
    resettable: false,
    reading: false,
  },
  {
    provider: 'codex-cli',
    signIn: { state: 'signed-in', method: 'subscription' },
    usage: { windows: [{ span: 'week', used: 100, resetsAt: null }], resets: 2, readAt: now },
    resettable: true,
    reading: false,
  },
  { provider: 'grok-build', signIn: { state: 'signed-out' }, resettable: false, reading: false },
];

function bridge() {
  return {
    setShown: vi.fn<AccountsBridge['setShown']>(() => Promise.resolve()),
    reset: vi.fn<AccountsBridge['reset']>(() => Promise.resolve('reset')),
  };
}

describe('AccountsPanel', () => {
  it('lists each provider’s sign-in and a subscription’s windows with their use and reset, saying while it shows', () => {
    const given = bridge();
    const { unmount } = render(
      <AccountsPanel bridge={given} accounts={accounts} onSignIn={vi.fn()} />,
    );
    expect(given.setShown).toHaveBeenCalledWith(true);
    const [claude, codex, grok] = screen
      .getAllByRole('listitem')
      .filter((item) => item.querySelector('h3'));
    if (claude === undefined || codex === undefined || grok === undefined)
      throw new Error('A row is missing.');
    expect(within(claude).getByRole('heading').textContent).toContain('Claude Code');
    expect(claude.textContent).toContain('Signed in with a subscription');
    expect(
      within(claude).getByRole('meter', { name: '5-hour limit' }).getAttribute('aria-valuenow'),
    ).toBe('84');
    expect(claude.textContent).toContain('84% used · Resets');
    expect(claude.textContent).toContain('Weekly limit · OpusUse not reported');
    expect(claude.textContent).toContain('Read 3 minutes ago');
    expect(codex.textContent).toContain('100% used');
    expect(codex.textContent).toContain('Read just now');
    expect(grok.textContent).toContain('Not signed in');
    unmount();
    expect(given.setShown).toHaveBeenLastCalledWith(false);
  });

  it('offers Sign In for a provider not signed in, and Codex’s reset, saying what it did', async () => {
    const given = bridge();
    const onSignIn = vi.fn();
    render(<AccountsPanel bridge={given} accounts={accounts} onSignIn={onSignIn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(onSignIn).toHaveBeenCalledWith('grok-build');
    expect(screen.getByText('2 resets left')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset Limits' }));
      await Promise.resolve();
    });
    expect(given.reset).toHaveBeenCalledWith('codex-cli');
    expect(screen.getByRole('status').textContent).toContain('The limits were reset.');
  });

  it('draws a dashed bar with the reason a subscription’s usage could not be read, and says that a sign-in is being checked', () => {
    render(
      <AccountsPanel
        bridge={bridge()}
        accounts={[
          {
            provider: 'claude-code',
            signIn: { state: 'signed-in', method: 'subscription' },
            usageProblem: 'refused',
            resettable: false,
            reading: false,
          },
          { provider: 'codex-cli', signIn: { state: 'unknown' }, resettable: true, reading: true },
          {
            provider: 'grok-build',
            signIn: { state: 'signed-in', method: 'subscription' },
            usage: { windows: [{ span: 'week', used: 30, resetsAt: null }], readAt: Date.now() },
            usageProblem: 'unreachable',
            resettable: false,
            reading: false,
          },
        ]}
        onSignIn={vi.fn()}
      />,
    );
    const reason = screen.getByText(
      'Couldn’t fetch the usage for this sign-in. Signing in again may help.',
    );
    // The bar beside the reason is its dashed outline alone.
    expect(reason.previousElementSibling?.className).toContain('border-dashed');
    expect(reason.previousElementSibling?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Checking…')).toBeTruthy();
    // A later read that fails keeps the windows read before, saying why it could not read them anew.
    expect(
      screen.getByText(/Read just now · Couldn’t ask Grok Build for its usage\./),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset Limits' })).toBeNull();
  });

  it('says each provider’s state right after its name, as a setting’s items do: signed in in the run colour, the rest quietly', () => {
    const shown: ProviderAccount[] = [
      {
        provider: 'claude-code',
        signIn: { state: 'signed-in', method: 'subscription' },
        resettable: false,
        reading: false,
      },
      { provider: 'codex-cli', signIn: { state: 'signed-out' }, resettable: false, reading: false },
      {
        provider: 'grok-build',
        signIn: { state: 'unknown' },
        install: { runs: null, pinned: '1.0.92' },
        resettable: false,
        reading: false,
      },
    ];
    render(<AccountsPanel bridge={bridge()} accounts={shown} onSignIn={vi.fn()} />);
    for (const [name, state, color] of [
      ['Claude Code', 'Signed in with a subscription', 'text-run'],
      ['Codex CLI', 'Not signed in', 'text-faint'],
      ['Grok Build', 'Not installed', 'text-faint'],
    ] as const) {
      const label = screen.getByRole('heading', { name }).nextElementSibling;
      expect(label?.textContent).toBe(state);
      expect(label?.className).toContain(color);
    }
  });
});

describe('AccountsButton', () => {
  it('opens the panel', () => {
    const onOpen = vi.fn();
    render(<AccountsButton onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('AccountsPanel and where the providers run from', () => {
  const row = (name: string) => {
    const found = screen
      .getAllByRole('listitem')
      .find((item) => item.querySelector('h3')?.textContent.includes(name));
    if (found === undefined) throw new Error(`No row for ${name}.`);
    return found;
  };

  it('says what runs for each provider, a CLI it passed over, and offers Sign In to one not installed', () => {
    const onSignIn = vi.fn();
    render(
      <AccountsPanel
        bridge={bridge()}
        onSignIn={onSignIn}
        accounts={[
          {
            provider: 'claude-code',
            signIn: { state: 'signed-in', method: 'subscription' },
            install: { runs: { source: 'user', version: '2.1.340' }, pinned: '2.1.330' },
            resettable: false,
            reading: false,
          },
          {
            provider: 'codex-cli',
            signIn: { state: 'signed-in', method: 'subscription' },
            install: {
              runs: { source: 'app', version: '0.170.0' },
              passedOver: { path: '/usr/local/bin/codex', version: '0.100.0', oldest: '0.171.0' },
              pinned: '0.171.0',
            },
            resettable: false,
            reading: false,
          },
          {
            provider: 'grok-build',
            signIn: { state: 'unknown' },
            install: { runs: null, pinned: '1.0.92', failed: 'checksum' },
            resettable: false,
            reading: false,
          },
        ]}
      />,
    );
    expect(row('Claude Code').textContent).toContain('Runs your CLI, 2.1.340');
    expect(within(row('Claude Code')).queryByRole('button', { name: 'Sign In' })).toBeNull();
    const codex = row('Codex CLI');
    expect(codex.textContent).toContain('Runs the app’s copy, 0.170.0');
    expect(codex.textContent).toContain(
      'Your CLI at /usr/local/bin/codex is 0.100.0, older than 0.171.0, the oldest the app runs.',
    );
    expect(codex.textContent).toContain('Updates to 0.171.0 at the next sign-in or session.');
    const grok = row('Grok Build');
    expect(grok.textContent).toContain('Not installed');
    expect(grok.textContent).toContain('Sign In downloads the app’s copy, 1.0.92, first.');
    expect(grok.textContent).toContain('didn’t match its checksum');
    fireEvent.click(within(grok).getByRole('button', { name: 'Sign In' }));
    expect(onSignIn).toHaveBeenCalledWith('grok-build');
  });

  it('shows a download’s progress in place of Sign In', () => {
    render(
      <AccountsPanel
        bridge={bridge()}
        onSignIn={vi.fn()}
        accounts={[
          {
            provider: 'grok-build',
            signIn: { state: 'unknown' },
            install: { runs: null, pinned: '1.0.92', downloading: { received: 25, total: 100 } },
            resettable: false,
            reading: false,
          },
          {
            provider: 'codex-cli',
            signIn: { state: 'unknown' },
            install: {
              runs: null,
              pinned: '0.171.0',
              downloading: { received: 3_000_000, total: null },
            },
            resettable: false,
            reading: false,
          },
        ]}
      />,
    );
    const grok = row('Grok Build');
    expect(within(grok).queryByRole('button', { name: 'Sign In' })).toBeNull();
    expect(within(grok).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(grok.textContent).toContain('Downloading 1.0.92… 25%');
    expect(row('Codex CLI').textContent).toContain('Downloading 0.171.0… 3 MB');
  });
});
