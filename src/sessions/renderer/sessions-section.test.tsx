import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { SessionSummary } from '../shared/sessions';
import { SessionsSection, type SessionFolder } from './sessions-section';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

function session(id: string, cwd: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    provider: 'claude-code',
    sessionId: `p-${id}`,
    cwd,
    status: 'idle',
    openedAt: 0,
    ...extra,
  };
}

const folders: SessionFolder[] = [
  { id: 'w1', name: 'web', path: '/Users/me/web' },
  { id: 'w2', name: 'api', path: '/Users/me/api' },
];

const sessions = [
  session('s1', '/Users/me/web', { title: 'Fix the build', status: 'running' }),
  session('s2', '/Users/me/web/packages/ui', { provider: 'codex', status: 'waiting' }),
  session('s3', '/Users/me/website', { title: 'Landing page', status: 'closed' }),
  session('s4', '/Users/me/api', { provider: 'grok-build', title: '' }),
];

const region = () => screen.getByRole('region', { name: 'Sessions' });
const rows = () =>
  within(region())
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

describe('SessionsSection', () => {
  it('shows the heading row alone without sessions or folders', () => {
    render(<SessionsSection sessions={[]} folders={[]} />);
    expect(region().textContent).toBe('Sessions');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(within(region()).getByRole('button', { name: 'New session' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows every session with its status and its folder, whose path is the tooltip', () => {
    render(<SessionsSection sessions={sessions} folders={folders} />);
    expect(rows()).toEqual([
      'RunningFix the buildweb',
      'Waiting for youCodexui',
      'ClosedLanding pagewebsite',
      // Without a title, a session goes by its provider.
      'IdleGrok Buildapi',
    ]);
    expect(within(region()).getByText('ui').title).toBe('/Users/me/web/packages/ui');
  });

  it('narrows the list to the sessions in one workspace and its subfolders', () => {
    render(<SessionsSection sessions={sessions} folders={folders} />);
    const filter = screen.getByRole('combobox', { name: 'Filter sessions by workspace' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All workspaces', 'web', 'api']);
    fireEvent.change(filter, { target: { value: 'w1' } });
    expect(rows()).toEqual(['RunningFix the buildweb', 'Waiting for youCodexui']);
    fireEvent.change(filter, { target: { value: 'w2' } });
    expect(rows()).toEqual(['IdleGrok Buildapi']);
    fireEvent.change(filter, { target: { value: '' } });
    expect(rows()).toHaveLength(4);
  });

  it('shows every session again when the chosen workspace leaves the list', () => {
    const { rerender } = render(<SessionsSection sessions={sessions} folders={folders} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'w2' } });
    expect(rows()).toHaveLength(1);
    rerender(<SessionsSection sessions={sessions} folders={folders.slice(0, 1)} />);
    expect(rows()).toHaveLength(4);
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('');
  });
});
