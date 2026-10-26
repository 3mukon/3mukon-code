import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Plus } from './icons';

afterEach(cleanup);

describe('icons', () => {
  it('draw in the current text colour and are hidden from VoiceOver', () => {
    const { container } = render(<Plus className="size-4" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('class')).toContain('size-4');
  });
});
