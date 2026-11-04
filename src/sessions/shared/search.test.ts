import { describe, expect, it } from 'vitest';
import { searchWords } from './search';

describe('search', () => {
  it('takes a query’s words, whatever their case and the spaces between them', () => {
    expect(searchWords('  Fix   the BUILD ')).toEqual(['fix', 'the', 'build']);
    expect(searchWords(' ')).toEqual([]);
    expect(searchWords('修复 构建')).toEqual(['修复', '构建']);
  });
});
