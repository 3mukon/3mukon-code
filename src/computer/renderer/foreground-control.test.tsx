import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { ForegroundControlBar, type ControlState } from './foreground-control';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

function bar(state: ControlState, shortcut = true) {
  const onStop = vi.fn(() => Promise.resolve(true));
  const onHandBack = vi.fn(() => Promise.resolve(true));
  const view = render(
    <ForegroundControlBar
      state={state}
      session="Reply to invoices"
      application="Mail"
      shortcut={shortcut}
      onStop={onStop}
      onHandBack={onHandBack}
    />,
  );
  return { ...view, onStop, onHandBack };
}

describe('ForegroundControlBar', () => {
  it('names the session and the application with Stop and the shortcut, which shows only where it is registered', () => {
    const { onStop } = bar('acting');
    expect(screen.getByText('Reply to invoices is using Mail').className).toContain('font-medium');
    expect(screen.getByText('⌃⌥⌘.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    cleanup();
    bar('acting', false);
    expect(screen.queryByText('⌃⌥⌘.')).toBeNull();
  });

  it('says the user has control after a takeover, with Hand Back and Stop', () => {
    const { container, onHandBack } = bar('user');
    expect(screen.getByText('You have control of Mail')).toBeDefined();
    expect(screen.getByText('Reply to invoices')).toBeDefined();
    expect(container.querySelector('.lucide-mouse-pointer-2')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hand Back' }));
    expect(onHandBack).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDefined();
  });

  it('says why Secure Input paused it, and when an application came to the front', () => {
    const { container } = bar('secure-input');
    expect(screen.getByText('Paused while a password field has the keyboard')).toBeDefined();
    expect(container.querySelector('.lucide-lock')?.getAttribute('class')).toContain('text-wait');
    expect(screen.queryByRole('button', { name: 'Hand Back' })).toBeNull();
    cleanup();
    bar('came-forward');
    expect(screen.getByText('Mail came to the front')).toBeDefined();
    expect(screen.getByText('Reply to invoices')).toBeDefined();
  });

  it('holds Stop while the work stops, and says when a step did not go', async () => {
    bar('stopping');
    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(true);
    cleanup();
    const onStop = vi.fn(() => Promise.resolve(false));
    render(
      <ForegroundControlBar
        state="acting"
        session="Reply to invoices"
        application="Mail"
        shortcut
        onStop={onStop}
        onHandBack={() => Promise.resolve(true)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(() => Promise.resolve());
    expect(screen.getByRole('status').textContent).toBe('That didn’t work.');
  });
});
