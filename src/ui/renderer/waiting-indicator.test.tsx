import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WaitingIndicator } from './waiting-indicator';

afterEach(cleanup);

describe('WaitingIndicator', () => {
  it('renders nothing while no session is waiting', () => {
    const { container } = render(
      <WaitingIndicator count={0} label="Show it" onActivate={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows the count as a labelled button that jumps when activated', () => {
    const onActivate = vi.fn();
    render(<WaitingIndicator count={2} label="2 sessions are waiting" onActivate={onActivate} />);
    const button = screen.getByRole('button', { name: '2 sessions are waiting' });
    expect(button.textContent).toBe('2');
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledOnce();
  });
});
