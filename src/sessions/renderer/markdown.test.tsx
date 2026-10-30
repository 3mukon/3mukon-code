import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { Markdown } from './markdown';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

// The TeX of each formula KaTeX set, from the MathML it adds for VoiceOver.
const formulas = (container: HTMLElement) =>
  [...container.querySelectorAll('annotation[encoding="application/x-tex"]')].map(
    (annotation) => annotation.textContent,
  );

describe('Markdown', () => {
  it('sets math in each delimiter models write, inline and on its own', () => {
    const { container } = render(
      <Markdown
        text={'Let $x^2$ and \\(a+b\\) be.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n\\[ E = mc^2 \\]'}
      />,
    );
    expect(formulas(container)).toEqual(['x^2', 'a+b', '\\int_0^1 x\\,dx', 'E = mc^2']);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2);
  });

  it('leaves prices as text, and shows a formula KaTeX cannot read in place', () => {
    const { container } = render(<Markdown text={'It costs $5, or $6.\n\n$\\frac{1}{$'} />);
    expect(container.textContent).toContain('It costs $5, or $6.');
    expect(container.querySelector('.katex-error')).not.toBeNull();
  });

  it('highlights code whose block names its language, and leaves other code plain', () => {
    const { container } = render(
      <Markdown
        text={'```ts\nconst answer = 42;\n```\n\n```\nconst plain = 1;\n```\n\n`const inline`'}
      />,
    );
    const [named, unnamed] = [...container.querySelectorAll('pre code')];
    expect(named?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(named?.querySelector('.hljs-number')?.textContent).toBe('42');
    expect(unnamed?.querySelector('[class^="hljs-"]')).toBeNull();
    expect(screen.getByText('const inline').className).toContain('bg-well');
  });

  it('keeps a table column’s alignment', () => {
    render(<Markdown text={'| Name | Count |\n| :-- | --: |\n| a | 1 |'} />);
    expect(screen.getByText('1').style.textAlign).toBe('right');
  });
});
