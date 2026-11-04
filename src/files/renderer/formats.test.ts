import { describe, expect, it } from 'vitest';
import { formatOf, nodeOf, parseData, parseTable } from './formats';

describe('formatOf', () => {
  it('knows a file’s format by its extension, whatever its case', () => {
    expect(formatOf('/w/README.md', '')).toEqual({ format: 'markdown', sniffed: false });
    expect(formatOf('/w/data.JSON', '')).toEqual({ format: 'json', sniffed: false });
    expect(formatOf('/w/a.yml', '')?.format).toBe('yaml');
    expect(formatOf('/w/Cargo.toml', '')?.format).toBe('toml');
    expect(formatOf('/w/a.tsv', '')?.format).toBe('tsv');
    expect(formatOf('/w/logo.svg', '')?.format).toBe('svg');
    expect(formatOf('/w/Info.plist', '')?.format).toBe('xml');
    expect(formatOf('/w/main.ts', '{}')).toBeNull();
  });

  it('knows a file without an extension as JSON or XML by how its text begins', () => {
    expect(formatOf('/w/.prettierrc', '  {"semi": false}')).toEqual({
      format: 'json',
      sniffed: true,
    });
    expect(formatOf('/w/feed', '<?xml version="1.0"?><rss/>')).toEqual({
      format: 'xml',
      sniffed: true,
    });
    expect(formatOf('/w/Makefile', 'all:\n\techo')).toBeNull();
  });
});

describe('the data formats', () => {
  it('reads JSON as a tree, and says where it fails by line and column', () => {
    expect(parseData('json', '{"a": [1, true, null], "b": "x"}')).toEqual({
      ok: true,
      value: nodeOf({ a: [1, true, null], b: 'x' }),
    });
    expect(parseData('json', '{\n  "a": 1\n  "b": 2\n}')).toEqual({
      ok: false,
      failure: { line: 3, column: 3 },
    });
  });

  it('reads YAML, a stream of documents as an array of them, and says where it fails', () => {
    expect(parseData('yaml', 'name: app\nports: [80, 443]\n')).toEqual({
      ok: true,
      value: nodeOf({ name: 'app', ports: [80, 443] }),
    });
    expect(parseData('yaml', 'a: 1\n---\nb: 2\n')).toEqual({
      ok: true,
      value: { kind: 'array', items: [nodeOf({ a: 1 }), nodeOf({ b: 2 })] },
    });
    expect(parseData('yaml', 'a: 1\na: 2\n')).toEqual({
      ok: false,
      failure: { line: 2, column: 1 },
    });
  });

  it('reads TOML with its dates, and says where it fails', () => {
    const parsed = parseData('toml', 'title = "app"\n[owner]\nborn = 1979-05-27T07:32:00Z\n');
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: 'object',
        entries: [
          ['title', { kind: 'value', type: 'string', text: 'app' }],
          [
            'owner',
            {
              kind: 'object',
              entries: [
                ['born', { kind: 'value', type: 'date', text: '1979-05-27T07:32:00.000Z' }],
              ],
            },
          ],
        ],
      },
    });
    expect(parseData('toml', 'a = 1\nb = = 2\n')).toMatchObject({
      ok: false,
      failure: { line: 2 },
    });
  });
});

describe('parseTable', () => {
  it('reads quoted fields with separators, doubled quotes and line breaks, and either line break', () => {
    expect(parseTable('name,note\r\n"Ink, Paper","says ""hi""\nthere"\nx,\n', ',')).toEqual({
      ok: true,
      value: [
        ['name', 'note'],
        ['Ink, Paper', 'says "hi"\nthere'],
        ['x', ''],
      ],
    });
    expect(parseTable('a\tb\n1\t2', '\t')).toEqual({
      ok: true,
      value: [
        ['a', 'b'],
        ['1', '2'],
      ],
    });
  });

  it('says where a quote is left open', () => {
    expect(parseTable('a,b\n1,"open\n', ',')).toEqual({
      ok: false,
      failure: { line: 2, column: 3 },
    });
  });
});
