import { describe, expect, it } from 'vitest';
import { withMathDelimiters } from './math-delimiters';

describe('withMathDelimiters', () => {
  it('writes \\(…\\) as $…$ and \\[…\\] as a $$ block', () => {
    expect(withMathDelimiters('Area \\( \\pi r^2 \\) here.')).toBe('Area $\\pi r^2$ here.');
    expect(withMathDelimiters('So\n\\[ E = mc^2 \\]\ndone')).toBe('So\n\n$$\nE = mc^2\n$$\n\ndone');
  });

  it('keeps single-dollar math and $$ math, and escapes prices and shell variables in prose', () => {
    expect(withMathDelimiters('Let $x^2$ and $a + b$ be.')).toBe('Let $x^2$ and $a + b$ be.');
    expect(withMathDelimiters('$$\\int_0^1 x$$')).toBe('$$\\int_0^1 x$$');
    expect(withMathDelimiters('It costs $5, or $6.50.')).toBe('It costs \\$5, or \\$6.50.');
    expect(withMathDelimiters('Set $HOME and $PATH.')).toBe('Set \\$HOME and \\$PATH.');
    expect(withMathDelimiters('A $ 5 $ gap, and \\$ kept.')).toBe('A \\$ 5 \\$ gap, and \\$ kept.');
  });

  it('leaves code as it is', () => {
    const code = 'Run `echo $HOME`:\n\n```sh\necho $PATH \\( x \\)\n```\n';
    expect(withMathDelimiters(code)).toBe(code);
  });
});
