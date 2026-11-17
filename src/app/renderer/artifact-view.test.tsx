import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { Artifact, PresentationBridge } from '../../panels/shared/presentation';
import { ArtifactView, useArtifacts } from './artifact-view';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

// A 1 by 1 PNG, which the window draws as data.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('ArtifactView', () => {
  it('draws Markdown as a document, an image fitted to the panel, and a table with its columns as the header', () => {
    const { rerender } = render(
      <ArtifactView
        state={{
          status: 'ready',
          artifact: { format: 'markdown', title: 'Notes', text: '# Findings\n\nAll **green**.' },
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Findings' })).toBeTruthy();
    rerender(
      <ArtifactView
        state={{
          status: 'ready',
          artifact: {
            format: 'image',
            title: 'Chart',
            mediaType: 'image/png',
            data: PIXEL,
            width: 1,
            height: 1,
          },
        }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Chart' }).getAttribute('src')).toBe(
      `data:image/png;base64,${PIXEL}`,
    );
    rerender(
      <ArtifactView
        state={{
          status: 'ready',
          artifact: {
            format: 'table',
            title: 'Runs',
            columns: ['Test', 'Passed', 'Time'],
            rows: [
              ['unit', true, 1.5],
              ['smoke', false, null],
            ],
          },
        }}
      />,
    );
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Test',
      'Passed',
      'Time',
    ]);
    expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'unit',
      'true',
      '1.5',
      'smoke',
      'false',
      '',
    ]);
  });

  it('says so while a result is read, once it has gone, and when it is outside the limits', () => {
    const { rerender } = render(<ArtifactView state={{ status: 'loading' }} />);
    expect(screen.getByText('Loading the result…')).toBeTruthy();
    rerender(<ArtifactView state={{ status: 'gone' }} />);
    expect(screen.getByText('This result is no longer available.')).toBeTruthy();
    rerender(<ArtifactView state={{ status: 'invalid' }} />);
    expect(screen.getByText('This result can’t be shown.')).toBeTruthy();
  });
});

describe('useArtifacts', () => {
  const markdown: Artifact = { format: 'markdown', title: 'Notes', text: 'Text' };

  it('reads each shown artifact once, and checks it against the limits again', async () => {
    const held = new Map<string, Artifact | null>([
      ['notes', markdown],
      ['gone', null],
      ['huge', { format: 'markdown', title: 'Huge', text: 'x'.repeat(256 * 1024 + 1) }],
    ]);
    const artifact = vi.fn<PresentationBridge['artifact']>((id) =>
      Promise.resolve(held.get(id) ?? null),
    );
    const bridge: PresentationBridge = {
      onMessage: () => () => undefined,
      send: vi.fn(),
      artifact,
    };
    const { result, rerender } = renderHook(({ shown }) => useArtifacts(bridge, shown), {
      initialProps: { shown: ['notes', 'gone', 'huge', 'notes'] },
    });
    await act(() => Promise.resolve());
    expect(Object.fromEntries(result.current)).toEqual({
      notes: { status: 'ready', artifact: markdown },
      gone: { status: 'gone' },
      huge: { status: 'invalid' },
    });
    rerender({ shown: ['notes', 'gone'] });
    await act(() => Promise.resolve());
    expect(artifact).toHaveBeenCalledTimes(3);
  });

  it('reads nothing without main’s bridge', () => {
    const { result } = renderHook(() => useArtifacts(undefined, ['notes']));
    expect(result.current.size).toBe(0);
  });
});
