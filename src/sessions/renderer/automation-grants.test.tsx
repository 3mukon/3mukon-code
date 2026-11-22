import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { Grant } from '../shared/automation';
import { GrantsLine } from './automation-grants';

beforeAll(() => {
  initI18n(['en-US']);
  // happy-dom has no popovers, which the sheet opens as: showing and hiding one only marks it.
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
    this.dataset.shown = 'true';
  };
  HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) {
    delete this.dataset.shown;
  };
});
afterEach(cleanup);

const settle = () => act(() => Promise.resolve());
const chromeTab: Grant = {
  id: 'g1',
  target: {
    ref: { id: 't1', kind: 'browser-tab', generation: 1 },
    owner: 's1',
    name: 'Inbox',
    address: 'https://mail.example.com/inbox',
    sharing: 'global',
    browser: 'chrome',
    profile: { id: 'Default', name: 'Personal' },
  },
  summaryAt: 0,
  operationKind: 'browser-tab',
  scope: 'operation',
  operationId: 'op-1',
  issuedAt: 0,
};
const mailForeground: Grant = {
  id: 'g2',
  target: { ref: { id: 'a1', kind: 'application', generation: 1 }, owner: 's1', name: 'Mail' },
  summaryAt: 0,
  operationKind: 'application-foreground',
  scope: 'session',
  issuedAt: 0,
};

describe('GrantsLine', () => {
  it('says nothing while the session holds no grant', () => {
    const { container } = render(<GrantsLine grants={[]} onEnd={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('says how many grants the session holds and what each lets it use', () => {
    render(<GrantsLine grants={[chromeTab, mailForeground]} onEnd={vi.fn()} />);
    expect(screen.getByText('2 grants').className).toContain('text-ink');
    screen.getByText(/· Chrome tab mail\.example\.com · Mail in the foreground$/);
  });

  it('lists each grant on Show, for this operation or this session, and ends one with End', async () => {
    const onEnd = vi.fn(() => Promise.resolve(true));
    render(<GrantsLine grants={[chromeTab, mailForeground]} onEnd={onEnd} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const sheet = screen.getByRole('dialog', { name: 'Grants' });
    expect(sheet.dataset.shown).toBe('true');
    const [first, second] = within(sheet).getAllByRole('listitem');
    if (first === undefined || second === undefined) throw new Error('Two grants were not listed.');
    within(first).getByText('Chrome');
    within(first).getByText('mail.example.com');
    within(first).getByText('this operation');
    within(second).getByText('Foreground');
    within(second).getByText('Mail');
    within(second).getByText('this session');
    expect(document.activeElement).toBe(
      within(first).getByRole('button', { name: 'End: Chrome tab mail.example.com' }),
    );
    fireEvent.click(within(second).getByRole('button', { name: 'End: Mail in the foreground' }));
    await settle();
    expect(onEnd).toHaveBeenCalledExactlyOnceWith('g2');
  });

  it('says when End did not go, and closes at Escape, giving the focus back to Show', async () => {
    render(<GrantsLine grants={[chromeTab]} onEnd={() => Promise.resolve(false)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const sheet = screen.getByRole('dialog', { name: 'Grants' });
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'End: Chrome tab mail.example.com' }),
    );
    await settle();
    expect(within(sheet).getByRole('status').textContent).toBe('It couldn’t be ended.');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Grants' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show' }));
  });
});
