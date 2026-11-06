import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './markdown';

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
    // Inline code takes its inset and fill from markdown.css, which leaves a block's code to its pre.
    const inline = screen.getByText('const inline');
    expect(inline.className).toBe('markdown-code');
    expect(inline.closest('pre')).toBeNull();
  });

  it('keeps a table column’s alignment', () => {
    render(<Markdown text={'| Name | Count |\n| :-- | --: |\n| a | 1 |'} />);
    expect(screen.getByText('1').style.textAlign).toBe('right');
  });

  it('draws images as it is told, links to them by default, and hands links that are not web links to whoever follows them', () => {
    const onLink = vi.fn();
    const { container, rerender } = render(
      <Markdown
        text={'![chart](img/chart.png) [guide](docs/guide.md) [site](https://example.com)'}
        onLink={onLink}
      />,
    );
    // Without a way to draw it, an image is a link to it, never fetched.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'chart' }).getAttribute('href')).toBe('img/chart.png');
    fireEvent.click(screen.getByRole('link', { name: 'guide' }));
    expect(onLink).toHaveBeenCalledWith('docs/guide.md');
    // A web link is left to the window, which opens it in the browser.
    const web = fireEvent.click(screen.getByRole('link', { name: 'site' }));
    expect(web).toBe(true);
    expect(onLink).toHaveBeenCalledOnce();
    rerender(
      <Markdown
        text="![chart](img/chart.png)"
        image={(src, alt) => <span data-testid="drawn">{`${alt}:${src}`}</span>}
      />,
    );
    expect(screen.getByTestId('drawn').textContent).toBe('chart:img/chart.png');
  });

  it('sets headings at a document’s sizes when asked, and at the activity’s otherwise', () => {
    const { rerender } = render(<Markdown text="# Title" />);
    expect(screen.getByRole('heading').tagName).toBe('H3');
    rerender(<Markdown text="# Title" document />);
    expect(screen.getByRole('heading').tagName).toBe('H1');
  });
});
