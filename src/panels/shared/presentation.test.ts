import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_LIMITS,
  DEFAULT_PLACEMENT,
  artifactWithinLimits,
  commandWithinLimits,
  sameContent,
  type Artifact,
  type PresentationCommand,
} from './presentation';

const command: PresentationCommand = {
  kind: 'present',
  commandId: 'command-1',
  epoch: 'page-1',
  owner: 'session-1',
  presentationId: 'presentation-1',
  version: 0,
  title: 'Pricing compared',
  items: [{ kind: 'artifact', artifactId: 'artifact-1' }],
  placement: DEFAULT_PLACEMENT,
};

const image = (data: string, edge = 100): Artifact => ({
  format: 'image',
  title: 'Chart',
  mediaType: 'image/png',
  data,
  width: edge,
  height: edge,
});

describe('the presentation contract', () => {
  it('takes commands within the limits, and no others', () => {
    expect(commandWithinLimits(command)).toBe(true);
    expect(commandWithinLimits({ kind: 'close', ...basis() })).toBe(true);
    expect(commandWithinLimits({ ...command, items: [] })).toBe(false);
    expect(
      commandWithinLimits({
        ...command,
        items: Array.from({ length: 5 }, (_, n) => ({
          kind: 'browser',
          tabId: `tab-${String(n)}`,
        })),
      }),
    ).toBe(false);
    expect(commandWithinLimits({ ...command, items: [{ kind: 'file', path: 'notes.md' }] })).toBe(
      false,
    );
    expect(commandWithinLimits({ ...command, items: [...command.items, ...command.items] })).toBe(
      false,
    );
    expect(commandWithinLimits({ ...command, title: '  ' })).toBe(false);
    expect(commandWithinLimits({ ...command, title: 'x'.repeat(121) })).toBe(false);
    expect(commandWithinLimits({ ...command, owner: '' })).toBe(false);
    expect(commandWithinLimits({ ...command, version: -1 })).toBe(false);
    expect(commandWithinLimits({ ...command, version: 0.5 })).toBe(false);
  });

  it('takes Markdown up to its limit in UTF-8 bytes', () => {
    const markdown = (text: string): Artifact => ({ format: 'markdown', title: 'Notes', text });
    expect(artifactWithinLimits(markdown('a'.repeat(ARTIFACT_LIMITS.markdownBytes)))).toBe(true);
    expect(artifactWithinLimits(markdown('a'.repeat(ARTIFACT_LIMITS.markdownBytes + 1)))).toBe(
      false,
    );
    expect(artifactWithinLimits(markdown('é'.repeat(ARTIFACT_LIMITS.markdownBytes / 2 + 1)))).toBe(
      false,
    );
    expect(artifactWithinLimits({ format: 'markdown', title: '', text: 'x' })).toBe(false);
  });

  it('takes images of its types, measured by their base64 text, up to its bytes and longest edge', () => {
    expect(artifactWithinLimits(image('A'.repeat(ARTIFACT_LIMITS.imageBase64Bytes)))).toBe(true);
    expect(artifactWithinLimits(image('A'.repeat(ARTIFACT_LIMITS.imageBase64Bytes + 4)))).toBe(
      false,
    );
    expect(artifactWithinLimits(image('AAAA', ARTIFACT_LIMITS.imageEdge))).toBe(true);
    expect(artifactWithinLimits(image('AAAA', ARTIFACT_LIMITS.imageEdge + 1))).toBe(false);
    expect(artifactWithinLimits(image('AAAA', 0))).toBe(false);
    expect(artifactWithinLimits(image('AAA'))).toBe(false);
    expect(artifactWithinLimits(image('AA$A'))).toBe(false);
    expect(
      artifactWithinLimits({ ...image('AAAA'), mediaType: 'image/svg+xml' } as unknown as Artifact),
    ).toBe(false);
  });

  it('takes tables with rows as wide as their columns, within their rows, columns and bytes', () => {
    const table = (columns: string[], rows: (string | number)[][]): Artifact => ({
      format: 'table',
      title: 'Prices',
      columns,
      rows,
    });
    expect(artifactWithinLimits(table(['Plan', 'Price'], [['Pro', 20]]))).toBe(true);
    expect(artifactWithinLimits(table(['Plan', 'Price'], [['Pro']]))).toBe(false);
    expect(artifactWithinLimits(table([], []))).toBe(false);
    const columns = Array.from({ length: ARTIFACT_LIMITS.tableColumns + 1 }, (_, n) => String(n));
    expect(artifactWithinLimits(table(columns, []))).toBe(false);
    const rows = Array.from({ length: ARTIFACT_LIMITS.tableRows + 1 }, () => ['x']);
    expect(artifactWithinLimits(table(['Plan'], rows))).toBe(false);
    const long = 'x'.repeat(ARTIFACT_LIMITS.tableBytes / 2);
    expect(artifactWithinLimits(table(['Plan'], [[long], [long]]))).toBe(false);
  });

  it('tells items that show the same apart from the rest', () => {
    expect(sameContent({ kind: 'file', path: '/a' }, { kind: 'file', path: '/a' })).toBe(true);
    expect(sameContent({ kind: 'file', path: '/a' }, { kind: 'file', path: '/b' })).toBe(false);
    expect(sameContent({ kind: 'browser', tabId: 't' }, { kind: 'computer', targetId: 't' })).toBe(
      false,
    );
  });
});

function basis() {
  return {
    commandId: 'command-2',
    epoch: 'page-1',
    owner: 'session-1',
    presentationId: 'presentation-1',
    version: 0,
  };
}
