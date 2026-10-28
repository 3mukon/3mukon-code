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
    expect(pane.getAttribute('aria-current')).toBe('true');
  });

  it('dims while another pane has focus, and asks for focus when pressed or focused', () => {
    const onFocus = vi.fn();
    render(
      <Pane {...props} focused={false} onFocus={onFocus}>
        <p>body</p>
      </Pane>,
    );
    const pane = screen.getByRole('region', { name: 'layout-refactor' });
    expect(pane.className).toContain('opacity-70');
    expect(pane.hasAttribute('aria-current')).toBe(false);
    fireEvent.pointerDown(pane);
    pane.focus();
    expect(onFocus).toHaveBeenCalledTimes(2);
  });

  it('lies in the title bar on request, moving the window from its header but for what takes clicks', () => {
    render(
      <Pane
        title="web"
        detail="me"
        focused
        onFocus={vi.fn()}
        onClose={vi.fn()}
        closeLabel="Close"
        inTitleBar
        clearsWindowButtons
      />,
    );
    const header = screen.getByRole('region', { name: 'web' }).querySelector('header');
    expect(header?.className).toContain('[-webkit-app-region:drag]');
    expect(header?.className).toContain('pl-[84px]');
    // The title and detail, which make the handle, and the button take clicks.
    const handle = screen.getByText('me').parentElement;
    expect(handle?.contains(screen.getByText('web'))).toBe(true);
    for (const part of [handle, screen.getByRole('button')]) {
      expect(part?.className).toContain('[-webkit-app-region:no-drag]');
    }
  });

  it('drags by its title and detail when its parent lets it', () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const { rerender } = render(<Pane title="web" detail="me" focused onFocus={vi.fn()} />);
    const handle = () => {
      const element = screen.getByText('me').parentElement;
      if (element === null) throw new Error('The handle is not shown.');
      return element;
    };
    expect(handle().getAttribute('draggable')).toBe('false');
    rerender(
      <Pane
        title="web"
        detail="me"
        focused
        onFocus={vi.fn()}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />,
    );
    expect(handle().getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(handle());
    fireEvent.dragEnd(handle());
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(onDragEnd).toHaveBeenCalledOnce();
  });

  it('goes without a status, shows its detail with a tooltip, and closes from its header', () => {
    const onClose = vi.fn();
    render(
      <Pane
        title="README.md"
        detail="web"
        detailTitle="/Users/me/web"
        focused
        onFocus={vi.fn()}
        onClose={onClose}
        closeLabel="Close panel"
      />,
    );
    const pane = screen.getByRole('region', { name: 'README.md' });
    expect(pane.textContent).toBe('README.mdweb');
    expect(screen.getByText('web').title).toBe('/Users/me/web');
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
