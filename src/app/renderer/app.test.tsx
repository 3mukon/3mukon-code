import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { App } from './app';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

describe('App', () => {
  it('shows the sidebar beside a blank main area, with no title text', () => {
    render(<App />);
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    within(sidebar).getByText('3mukon-code');
    within(sidebar).getByRole('heading', { name: 'Sessions' });
    within(sidebar).getByText('No sessions yet');
    expect(within(sidebar).getByRole('button', { name: 'New session' })).toHaveProperty(
      'disabled',
      true,
    );
    // The workspace label is the only place the name appears.
    expect(screen.getAllByText('3mukon-code')).toHaveLength(1);
    expect(screen.getByRole('main').textContent).toBe('');
  });

  it('hides the sidebar with Command-B and shows it again', () => {
    render(<App />);
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(false);
  });

  it('leaves B without Command, or with another modifier, alone', () => {
    render(<App />);
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'b', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'b', metaKey: true, altKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(false);
  });
});
