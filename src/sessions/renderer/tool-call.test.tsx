import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { FileChange } from '../shared/events';
import type { ToolItem } from '../shared/session-state';
import { FileChangeEntry, ToolCall } from './tool-call';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

function tool(fields: Partial<ToolItem>): ToolItem {
  return {
    type: 'tool',
    id: 't1',
    kind: 'other',
    title: '',
    status: 'completed',
    output: '',
    changes: [],
    ...fields,
  };
}

function change(path: string, diff: string, fields: Partial<FileChange> = {}): FileChange {
  return { id: path, path, kind: 'update', diff, ...fields };
}

// What an opened entry shows.
function bodyOf(line: HTMLElement): HTMLElement {
  const body = document.getElementById(line.getAttribute('aria-controls') ?? '');
  if (body === null) throw new Error('The entry shows nothing opened.');
  return body;
}

const edit = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';

describe('ToolCall', () => {
  it('shows a command’s call as one line, which opens on its command and output', () => {
    render(
      <ToolCall
        item={tool({
          kind: 'execute',
          title: 'Run the tests',
          command: 'pnpm test',
          output: 'ok 1\nok 2',
        })}
      />,
    );
    const line = screen.getByRole('button', { name: /Run the tests/ });
    // VoiceOver hears the kind and the state with the title.
    expect(line.textContent).toBe('Run:Run the testsDone');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ok 1', { exact: false })).toBeNull();
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(bodyOf(line).textContent).toBe('$ pnpm test\nok 1\nok 2');
    fireEvent.click(line);
    expect(screen.queryByText('ok 1', { exact: false })).toBeNull();
  });

  it('colours the icon by the state, brightens a running call, and marks a failed one', () => {
    const { container, rerender } = render(
      <ToolCall item={tool({ kind: 'read', title: 'src/a.ts', status: 'running' })} />,
    );
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-run');
    expect(screen.getByText('src/a.ts').className).toContain('text-ink');
    // Without output, there is nothing to open.
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ToolCall item={tool({ kind: 'read', title: 'src/a.ts', status: 'failed' })} />);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-del');
    expect(screen.getByText('src/a.ts').className).toContain('text-del');
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('shows an edit of one file with the file’s counts, and opened, its diff without the path again', () => {
    render(
      <ToolCall
        item={tool({
          kind: 'edit',
          title: 'src/a.ts',
          output: 'The file was updated.',
          changes: [change('src/a.ts', edit)],
        })}
      />,
    );
    const line = screen.getByRole('button', { name: /src\/a\.ts/ });
    expect(line.textContent).toContain('+1−1');
    fireEvent.click(line);
    expect(screen.getAllByText('src/a.ts')).toHaveLength(1);
    expect(screen.getByText('new').className).toContain('bg-add/10');
    // The diff takes the place of the tool's own report.
    expect(screen.queryByText('The file was updated.')).toBeNull();
  });

  it('shows an edit of several files with their total, and opened, each file above its diff', () => {
    render(
      <ToolCall
        item={tool({
          kind: 'edit',
          title: 'src/a.ts, src/b.ts',
          changes: [
            change('src/a.ts', edit),
            change('src/b.ts', '--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n', {
              kind: 'add',
            }),
          ],
        })}
      />,
    );
    const line = screen.getByRole('button', { name: /src\/a\.ts, src\/b\.ts/ });
    expect(line.textContent).toContain('+3−1');
    fireEvent.click(line);
    const body = within(bodyOf(line));
    expect(body.getByText('src/b.ts').parentElement?.textContent).toBe('src/b.ts+2−0');
    expect(body.getByText('src/a.ts')).toBeDefined();
  });

  it('opens on the images a call returned', () => {
    render(
      <ToolCall
        item={tool({
          kind: 'read',
          title: 'shot.png',
          images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
        })}
      />,
    );
    const line = screen.getByRole('button', { name: /shot\.png/ });
    fireEvent.click(line);
    expect(within(bodyOf(line)).getByRole('button', { name: 'Image 1' })).toBeDefined();
  });

  it('names a moved file by both its paths, and a call without a title by its command or kind', () => {
    const { rerender } = render(
      <ToolCall
        item={tool({
          kind: 'edit',
          changes: [change('a.ts', edit, { kind: 'move', newPath: 'b.ts' })],
        })}
      />,
    );
    expect(screen.getByText('a.ts → b.ts')).toBeDefined();
    rerender(<ToolCall item={tool({ kind: 'execute', command: 'ls' })} />);
    expect(screen.getByText('ls')).toBeDefined();
    rerender(<ToolCall item={tool({ kind: 'fetch' })} />);
    expect(screen.getByText('Fetch', { selector: '.truncate' })).toBeDefined();
  });
});

describe('FileChangeEntry', () => {
  it('shows a change no tool call made as an entry of its own, which opens on its diff', () => {
    render(<FileChangeEntry change={change('src/a.ts', edit)} />);
    const line = screen.getByRole('button', { name: /src\/a\.ts/ });
    expect(line.textContent).toBe('Edit:src/a.ts+1−1Done');
    fireEvent.click(line);
    expect(screen.getByText('old').className).toContain('bg-del/10');
  });
});
