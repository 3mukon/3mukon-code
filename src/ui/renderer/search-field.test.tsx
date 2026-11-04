import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchField } from './search-field';

afterEach(cleanup);

function Field({ onClose }: { onClose?: () => void }) {
  const [value, setValue] = useState('');
  return (
    <SearchField
      label="Search sessions"
      placeholder="Search"
      value={value}
      onChange={setValue}
      clearLabel="Clear search"
      {...(onClose === undefined ? {} : { onClose })}
    />
  );
}

describe('SearchField', () => {
  it('clears its query with its button, keeping the focus, and with Escape', () => {
    render(<Field />);
    const field = screen.getByRole('searchbox', { name: 'Search sessions' });
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    fireEvent.change(field, { target: { value: 'build' } });
    field.focus();
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(fireEvent.mouseDown(clear)).toBe(false);
    fireEvent.click(clear);
    expect(field).toHaveProperty('value', '');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'build' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveProperty('value', '');
  });

  it('closes where it can close: at Escape, and as it is left empty', () => {
    const onClose = vi.fn();
    render(<Field onClose={onClose} />);
    const field = screen.getByRole('searchbox');
    fireEvent.change(field, { target: { value: 'build' } });
    fireEvent.blur(field);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
