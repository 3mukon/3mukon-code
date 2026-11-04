import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { ProviderAccount, UsageWindow } from '../shared/accounts';
import { SignInPrompt, UsageNotice } from './session-notes';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
});

const account = (...windows: UsageWindow[]): ProviderAccount => ({
  provider: 'codex',
  signIn: { state: 'signed-in', method: 'subscription' },
  usage: { windows, readAt: 0 },
  resettable: true,
  reading: false,
});

describe('UsageNotice', () => {
  it('says nothing below 80% of every window', () => {
    const { container } = render(
      <UsageNotice
        account={account({ span: 'five-hour', used: 79, resetsAt: null })}
        onOpen={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('names the window most used from 80%, or reached, with when it resets, and opens the accounts', () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <UsageNotice
        account={account(
          { span: 'five-hour', used: 81, resetsAt: null },
          { span: 'week', used: 92, resetsAt: Date.now() + 60_000 },
        )}
        onOpen={onOpen}
      />,
    );
    const notice = screen.getByRole('button', { name: /Weekly limit 92% used · Resets/ });
    fireEvent.click(notice);
    expect(onOpen).toHaveBeenCalledOnce();
    rerender(
      <UsageNotice
        account={account({ span: 'five-hour', used: 100, resetsAt: null })}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByRole('button').textContent).toMatch(/^5-hour limit reached$/);
  });
});

describe('SignInPrompt', () => {
  it('says the provider is not signed in and offers its sign-in', () => {
    const onSignIn = vi.fn();
    render(<SignInPrompt provider="grok-build" onSignIn={onSignIn} />);
    expect(screen.getByText('Grok Build is not signed in.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(onSignIn).toHaveBeenCalledWith('grok-build');
  });
});
