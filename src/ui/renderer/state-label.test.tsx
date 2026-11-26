import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StateLabel } from './state-label';

afterEach(() => {
  cleanup();
});

describe('StateLabel', () => {
  it('draws a state in small type, quietly unless its tone says otherwise', () => {
    render(
      <p>
        <StateLabel text="Checking…" />
        <StateLabel text="Allowed" tone="success" />
        <StateLabel text="Unavailable" tone="error" />
        <StateLabel text="Not installed" tone="attention" />
      </p>,
    );
    expect(screen.getByText('Checking…').className).toBe('text-[11px] text-faint');
    expect(screen.getByText('Allowed').className).toBe('text-[11px] text-run');
    expect(screen.getByText('Unavailable').className).toBe('text-[11px] text-del');
    expect(screen.getByText('Not installed').className).toBe('text-[11px] text-wait');
  });
});
