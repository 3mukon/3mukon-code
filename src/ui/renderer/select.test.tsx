import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select } from './select';

afterEach(cleanup);

const options = [
  { value: '', label: 'Everything' },
  { value: 'one', label: 'One' },
];

describe('Select', () => {
  it('is a select named for VoiceOver and the tooltip, with the chosen option’s text in its place', () => {
    render(<Select label="Show" value="one" options={options} onChange={vi.fn()} />);
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Show' });
    expect(select.title).toBe('Show');
    expect(select.value).toBe('one');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Everything', 'One']);
    // The text shown is hidden from VoiceOver, which reads the select instead.
    const shown = select.parentElement?.firstElementChild;
    expect(shown?.textContent).toBe('One');
    expect(shown?.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens its list as e-ink draws it: a sheet of paper under a dashed line, without a shadow', () => {
    render(<Select label="Show" value="one" options={options} onChange={vi.fn()} />);
    const classes = screen.getByRole('combobox', { name: 'Show' }).className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining([
        '[&::picker(select)]:border-dashed',
        '[&::picker(select)]:paper',
        '[&::picker(select)]:shadow-none',
      ]),
    );
  });

  it('reports the option chosen', () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Select label="Show" value="" options={options} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'one' } });
    expect(onChange.mock.calls).toEqual([['one']]);
  });
});
