import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { FilesBridge } from '../shared/files';
import { PAGE } from './data-tree';
import { RenderedView, resolve, ViewToggle } from './rendered-view';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const bridge = () => ({
  image: vi.fn<FilesBridge['image']>(() =>
    Promise.resolve({ mediaType: 'image/png', data: 'iVBO' }),
  ),
});

describe('resolve', () => {
  it('takes a link’s path from the file’s folder, leaving out its query and fragment', () => {
    expect(resolve('/w/docs', 'guide.md')).toBe('/w/docs/guide.md');
    expect(resolve('/w/docs', './img/a%20b.png?raw=1#top')).toBe('/w/docs/img/a b.png');
    expect(resolve('/w/docs', '../README.md')).toBe('/w/README.md');
    expect(resolve('/w/docs', '/etc/hosts')).toBe('/etc/hosts');
    expect(resolve('/w/docs', 'https://example.com/a.md')).toBeNull();
    expect(resolve('/w/docs', '#usage')).toBeNull();
  });
});

describe('RenderedView', () => {
  it('renders Markdown as a document, opening linked files and showing the images beside it', async () => {
    const given = bridge();
    const onOpenFile = vi.fn();
    render(
      <RenderedView
        bridge={given}
        path="/w/docs/notes.md"
        format="markdown"
        text={'# Notes\n\nSee [the guide](guide.md).\n\n![chart](img/chart.png)'}
        onOpenFile={onOpenFile}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes');
    fireEvent.click(screen.getByRole('link', { name: 'the guide' }));
    expect(onOpenFile).toHaveBeenCalledWith('/w/docs/guide.md');
    await act(async () => {
      await Promise.resolve();
    });
    expect(given.image).toHaveBeenCalledWith('/w/docs/img/chart.png');
    expect(screen.getByRole('img', { name: 'chart' }).getAttribute('src')).toBe(
      'data:image/png;base64,iVBO',
    );
  });

  it('renders JSON as a tree whose first two levels are open, a folded entry saying what it holds', () => {
    render(
      <RenderedView
        bridge={bridge()}
        path="/w/a.json"
        format="json"
        text={'{"name": "app", "deps": {"react": {"version": "19"}}}'}
      />,
    );
    const tree = screen.getByRole('tree');
    expect(tree.textContent).toContain('name: "app"');
    // The third level, react's object, starts folded, saying how many entries it holds.
    const react = within(tree).getByRole('button', { name: /react/ });
    expect(react.textContent).toContain('1 entry');
    fireEvent.click(react);
    expect(tree.textContent).toContain('version: "19"');
  });

  it('shows a long array a page at a time', () => {
    const items = Array.from({ length: PAGE + 5 }, (_, index) => index);
    render(
      <RenderedView
        bridge={bridge()}
        path="/w/a.json"
        format="json"
        text={JSON.stringify(items)}
      />,
    );
    const more = screen.getByRole('button', { name: 'Show 5 more (5 left)' });
    fireEvent.click(more);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    expect(screen.getByRole('tree').textContent).toContain(
      `${String(PAGE + 4)}: ${String(PAGE + 4)}`,
    );
  });

  it('renders CSV as a table with its header, SVG as an image, and says where a text fails to parse', () => {
    const { rerender } = render(
      <RenderedView bridge={bridge()} path="/w/a.csv" format="csv" text={'name,age\nAda,36\n'} />,
    );
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'name',
      'age',
    ]);
    expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Ada', '36']);
    rerender(
      <RenderedView bridge={bridge()} path="/w/a.json" format="json" text={'{\n  "a": 1,\n}'} />,
    );
    expect(screen.getByText(/This JSON doesn’t parse at line 3, column 1\./)).toBeTruthy();
  });
});

describe('ViewToggle', () => {
  it('offers the rendered view and the raw text, the chosen one pressed', () => {
    const onChange = vi.fn();
    render(<ViewToggle view="rendered" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'View' });
    expect(
      within(group).getByRole('button', { name: 'Rendered' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(within(group).getByRole('button', { name: 'Raw' }));
    expect(onChange).toHaveBeenCalledWith('raw');
  });
});
