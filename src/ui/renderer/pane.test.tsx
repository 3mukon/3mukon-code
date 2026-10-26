import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pane } from './pane';

afterEach(cleanup);

const props = {
  title: 'layout-refactor',
  detail: 'Claude Code',
  status: 'running',
  statusLabel: 'Running',
} as const;

describe('Pane', () => {
  it('is a region named by its title that states its status in words', () => {
    render(
      <Pane {...props} focused onFocus={vi.fn()}>
        <p>Refactor the workspace layout.</p>
      </Pane>,
    );
    const pane = screen.getByRole('region', { name: 'layout-refactor' });
    expect(pane.textContent).toContain('Running');
    expect(pane.textContent).toContain('Claude Code');
    expect(pane.textContent).toContain('Refactor the workspace layout.');
    expect(pane.className).not.toContain('opacity-70');
  });

  it('dims while the other pane has focus, and asks for focus when pressed', () => {
    const onFocus = vi.fn();
    render(
      <Pane {...props} focused={false} onFocus={onFocus}>
        <p>body</p>
      </Pane>,
    );
    const pane = screen.getByRole('region', { name: 'layout-refactor' });
    expect(pane.className).toContain('opacity-70');
    fireEvent.pointerDown(pane);
    expect(onFocus).toHaveBeenCalled();
  });
});
