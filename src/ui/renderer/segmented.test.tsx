import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Segmented } from './segmented';

afterEach(cleanup);

const options = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function Choice({ start = 'system' }: { start?: string }) {
  const [value, setValue] = useState(start);
  return (
    <Segmented
      label="Appearance"
      detail="System follows macOS."
      value={value}
      options={options}
      onChange={setValue}
    />
  );
}

describe('Segmented', () => {
  it('is a radio group named by its label and described by its detail, the chosen option in ink', () => {
    render(<Choice />);
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect(group.getAttribute('aria-describedby')).not.toBeNull();
    screen.getByText('System follows macOS.');
    const system = screen.getByRole('radio', { name: 'System' });
    expect(system.getAttribute('aria-checked')).toBe('true');
    expect(system.className).toContain('bg-ink');
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    expect(system.getAttribute('aria-checked')).toBe('false');
  });

  it('lets Tab reach the chosen option alone, and the arrow keys, Home and End choose another', () => {
    render(<Choice start="light" />);
    const [system, light, dark] = screen.getAllByRole('radio');
    expect([system, light, dark].map((radio) => radio?.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ]);
    if (light === undefined || dark === undefined || system === undefined) throw new Error();
    fireEvent.keyDown(light, { key: 'ArrowRight' });
    expect(dark.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(dark, { key: 'ArrowRight' });
    expect(system.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(system, { key: 'End' });
    expect(dark.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(dark, { key: 'Home' });
    expect(system.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(system, { key: 'ArrowUp' });
    expect(dark.getAttribute('aria-checked')).toBe('true');
  });

  it('lets Tab reach the first option while none is chosen', () => {
    render(<Choice start="sepia" />);
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
    ]);
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
  });
});
