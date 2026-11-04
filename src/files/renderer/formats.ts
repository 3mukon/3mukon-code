import { parse as parseToml, TomlError } from 'smol-toml';
import { parseAllDocuments } from 'yaml';

// The formats a file renders in (ADR-0018).
export type FileFormat = 'markdown' | 'json' | 'xml' | 'yaml' | 'toml' | 'csv' | 'tsv' | 'svg';

const byExtension: Record<string, FileFormat | undefined> = {
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  json: 'json',
  geojson: 'json',
  webmanifest: 'json',
  har: 'json',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  plist: 'xml',
  rss: 'xml',
  atom: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  svg: 'svg',
};

// A file's format by its name's extension; a name without one, a hidden file's included, by how its
// text begins, as JSON or XML, which counts only if the text then parses (`sniffed`).
export function formatOf(
  path: string,
  text: string,
): { format: FileFormat; sniffed: boolean } | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const format = byExtension[name.slice(dot + 1).toLowerCase()];
    return format === undefined ? null : { format, sniffed: false };
  }
  const start = text.trimStart();
  if (start.startsWith('{') || start.startsWith('[')) return { format: 'json', sniffed: true };
  if (/^<(\?xml|[A-Za-z_])/.test(start)) return { format: 'xml', sniffed: true };
  return null;
}

// Where a text fails to parse, counted from 1.
export interface ParseFailure {
  line: number;
  column: number;
}

// A value of a data format as the tree shows it: an object or table by its keys, an array by its
// items, an XML element with its attributes and children, or a value, typed for its colour.
export type DataNode =
  | { kind: 'object'; entries: [string, DataNode][] }
  | { kind: 'array'; items: DataNode[] }
  | {
      kind: 'element';
      name: string;
      attributes: [string, string][];
      children: DataNode[];
    }
  | { kind: 'value'; type: 'string' | 'number' | 'boolean' | 'null' | 'date'; text: string }
  | { kind: 'text'; text: string };

export type Parsed<Result> = { ok: true; value: Result } | { ok: false; failure: ParseFailure };

// A JSON, YAML or TOML text, or an XML one, as a tree.
export function parseData(
  format: 'json' | 'yaml' | 'toml' | 'xml',
  text: string,
): Parsed<DataNode> {
  switch (format) {
    case 'json':
      return parseJson(text);
    case 'yaml':
      return parseYaml(text);
    case 'toml':
      return parseTomlText(text);
    case 'xml':
      return parseXml(text, 'application/xml');
  }
}

// A value JSON.parse, YAML or TOML gives, as a tree.
export function nodeOf(value: unknown): DataNode {
  if (value === null || value === undefined) return { kind: 'value', type: 'null', text: 'null' };
  if (Array.isArray(value)) return { kind: 'array', items: value.map(nodeOf) };
  if (value instanceof Date) return { kind: 'value', type: 'date', text: dateText(value) };
  switch (typeof value) {
    case 'string':
      return { kind: 'value', type: 'string', text: value };
    case 'number':
    case 'bigint':
      return { kind: 'value', type: 'number', text: String(value) };
    case 'boolean':
      return { kind: 'value', type: 'boolean', text: String(value) };
    case 'object':
      return {
        kind: 'object',
        entries: Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          nodeOf(entry),
        ]),
      };
    default:
      // A parser gives no other values.
      return { kind: 'value', type: 'null', text: 'null' };
  }
}

// A date as TOML and YAML write one, or as its own text where it is no valid date.
function dateText(date: Date): string {
  return Number.isNaN(date.getTime()) ? String(date) : date.toISOString();
}

function parseJson(text: string): Parsed<DataNode> {
  try {
    return { ok: true, value: nodeOf(JSON.parse(text)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const at = /\(line (\d+) column (\d+)\)/.exec(message);
    if (at !== null) return failed(Number(at[1]), Number(at[2]));
    const position = /at position (\d+)/.exec(message);
    return failedAt(text, position === null ? text.length : Number(position[1]));
  }
}

function parseYaml(text: string): Parsed<DataNode> {
  const documents = parseAllDocuments(text, { prettyErrors: true });
  const all = Array.isArray(documents) ? documents : [];
  for (const document of all) {
    const [error] = document.errors;
    if (error !== undefined) {
      const at = error.linePos?.[0];
      return failed(at?.line ?? 1, at?.col ?? 1);
    }
  }
  try {
    const values = all.map((document) => nodeOf(document.toJS()));
    const [only] = values;
    return {
      ok: true,
      value: values.length === 1 && only !== undefined ? only : { kind: 'array', items: values },
    };
  } catch {
    return failed(1, 1);
  }
}

function parseTomlText(text: string): Parsed<DataNode> {
  try {
    return { ok: true, value: nodeOf(parseToml(text)) };
  } catch (error) {
    if (error instanceof TomlError) return failed(error.line, error.column);
    return failed(1, 1);
  }
}

// An XML text through the window's own parser, which loads nothing; whitespace between elements is
// left out, and comments and processing instructions with it.
export function parseXml(text: string, type: DOMParserSupportedType): Parsed<DataNode> {
  const document = new DOMParser().parseFromString(text, type);
  const error = document.getElementsByTagName('parsererror')[0];
  if (error !== undefined) {
    const at = /line (\d+) at column (\d+)/.exec(error.textContent);
    return at === null ? failed(1, 1) : failed(Number(at[1]), Number(at[2]));
  }
  return { ok: true, value: elementOf(document.documentElement) };
}

function elementOf(element: Element): DataNode {
  const children: DataNode[] = [];
  for (const child of element.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) children.push(elementOf(child as Element));
    else if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
      const text = child.textContent?.trim() ?? '';
      if (text !== '') children.push({ kind: 'text', text });
    }
  }
  return {
    kind: 'element',
    name: element.tagName,
    attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    children,
  };
}

// The rows of a CSV or TSV text, as RFC 4180 reads them: fields in double quotes may hold the
// separator, line breaks and doubled quotes; a line break ends a row, and a last empty line adds none.
export function parseTable(text: string, separator: ',' | '\t'): Parsed<string[][]> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let quoteLine = 1;
  let quoteColumn = 1;
  let line = 1;
  let column = 1;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
        column += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') {
      quoted = true;
      quoteLine = line;
      quoteColumn = column;
    } else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line++;
      column = 1;
      continue;
    } else {
      field += char;
    }
    if (char === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  if (quoted) return failed(quoteLine, quoteColumn);
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { ok: true, value: rows };
}

function failed(line: number, column: number): { ok: false; failure: ParseFailure } {
  return { ok: false, failure: { line, column } };
}

// The line and column of a position in the text.
function failedAt(text: string, position: number): { ok: false; failure: ParseFailure } {
  const before = text.slice(0, position).split('\n');
  return failed(before.length, (before.at(-1)?.length ?? 0) + 1);
}
