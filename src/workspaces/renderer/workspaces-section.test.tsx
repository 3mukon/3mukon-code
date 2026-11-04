import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PointerEvent } from 'react';
import { initI18n } from '../../i18n/renderer/i18n';
import type { FolderListing, WorkspaceList, WorkspacesBridge } from '../shared/workspaces';
import type { TreeItem } from './workspace-tree';
import { WorkspacesSection } from './workspaces-section';

beforeAll(() => {
  initI18n(['en-US']);
});
// A click on a workspace waits for a possible second press; the tests let that time pass at will.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const list: WorkspaceList = {
  workspaces: [
    { id: 'w1', name: 'web', path: '/Users/me/web', trusted: true },
    { id: 'w2', name: 'api', path: '/Users/me/api', trusted: false },
  ],
  selectedId: 'w1',
};

// Folders by workspace id and path, as the main process would list them.
const folders: Record<string, FolderListing> = {
  'w1:': {
    entries: [
      { name: 'src', kind: 'folder' },
      { name: 'README.md', kind: 'file' },
    ],
  },
  'w1:src': { entries: [{ name: 'main.ts', kind: 'file' }] },
  'w2:': { error: 'unreadable' },
};

function fakeBridge() {
  return {
    get: vi.fn(() => Promise.resolve(list)),
    onChange: vi.fn(() => () => undefined),
    add: vi.fn(() => Promise.resolve()),
    addDropped: vi.fn<WorkspacesBridge['addDropped']>(() => Promise.resolve()),
    select: vi.fn<WorkspacesBridge['select']>(() => Promise.resolve()),
    showMenu: vi.fn<WorkspacesBridge['showMenu']>(() => Promise.resolve(null)),
    listFolder: vi.fn((id: string, path: string) =>
      Promise.resolve(folders[`${id}:${path}`] ?? { entries: [] }),
    ),
  } satisfies WorkspacesBridge;
}

function renderSection(bridge = fakeBridge(), shown = list) {
  render(<WorkspacesSection bridge={bridge} list={shown} />);
  return bridge;
}

const row = (name: string) => screen.getByRole('treeitem', { name });
// The row's own line, which takes clicks, as opposed to the rows inside it.
const line = (name: string) => row(name).firstElementChild as HTMLElement;
const settle = () => act(() => Promise.resolve());

// A double click as the page receives one: two presses and clicks, then the double click.
function doubleClick(element: HTMLElement) {
  fireEvent.mouseDown(element, { detail: 1 });
  fireEvent.click(element, { detail: 1 });
  fireEvent.mouseDown(element, { detail: 2 });
  fireEvent.click(element, { detail: 2 });
  fireEvent.doubleClick(element, { detail: 2 });
}

// A mouse event of this type and click count, which happened this many milliseconds after the page
// opened, as its time stamp says.
function mouseAt(type: string, detail: number, timeStamp: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
}

// Lets the time pass in which a second click could still follow a click, and the folders arrive.
async function waitForSecondClick() {
  act(() => {
    vi.runOnlyPendingTimers();
  });
  await settle();
}

describe('WorkspacesSection', () => {
  it('shows the heading alone without workspaces, and adds one with Add workspace', () => {
    const bridge = renderSection(fakeBridge(), { workspaces: [], selectedId: null });
    const section = screen.getByRole('region', { name: 'Workspaces' });
    expect(section.textContent).toBe('Workspaces');
    expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Add workspace' }));
    expect(bridge.add).toHaveBeenCalledOnce();
  });

  it('shows each workspace by name, with its path as the tooltip, and marks the selected and untrusted ones', () => {
    renderSection();
    const tree = screen.getByRole('tree', { name: 'Workspaces' });
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['web', 'api, Untrusted']);
    expect(row('web').getAttribute('aria-selected')).toBe('true');
    expect(row('api, Untrusted').getAttribute('aria-selected')).toBe('false');
    expect(line('web').title).toBe('/Users/me/web');
    expect(line('api, Untrusted').title).toBe('/Users/me/api');
    // Tab reaches the selected workspace.
    expect(row('web').tabIndex).toBe(0);
    expect(row('api, Untrusted').tabIndex).toBe(-1);
  });

  it('selects a workspace with a double click, Return or Space', async () => {
    const bridge = renderSection();
    doubleClick(line('web'));
    await settle();
    fireEvent.keyDown(row('api, Untrusted'), { key: 'Enter' });
    fireEvent.keyDown(row('web'), { key: ' ' });
    expect(bridge.select.mock.calls).toEqual([['w1'], ['w2'], ['w1']]);
  });

  it('opens and closes a workspace with a click once no second click has followed it', async () => {
    const bridge = renderSection();
    fireEvent.click(line('web'), { detail: 1 });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(row('web').getAttribute('aria-expanded')).toBe('false');
    await waitForSecondClick();
    expect(row('web').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(line('web'), { detail: 1 });
    await waitForSecondClick();
    expect(row('web').getAttribute('aria-expanded')).toBe('false');
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it('selects a workspace with a double click, without opening or closing it', async () => {
    const bridge = renderSection();
    doubleClick(line('web'));
    await waitForSecondClick();
    expect(row('web').getAttribute('aria-expanded')).toBe('false');
    // An open workspace stays open, with the folder open inside it.
    fireEvent.click(line('web'));
    await waitForSecondClick();
    fireEvent.click(line('src'));
    await settle();
    doubleClick(line('web'));
    await waitForSecondClick();
    expect(row('web').getAttribute('aria-expanded')).toBe('true');
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    expect(bridge.select.mock.calls).toEqual([['w1'], ['w1']]);
    expect(bridge.listFolder).toHaveBeenCalledTimes(2);
  });

  it('puts the tree back when a double click’s second press comes after its first click acted, and then waits longer', async () => {
    const bridge = renderSection();
    // The first click acts after 150ms, and the second press comes at 200ms.
    fireEvent(line('web'), mouseAt('click', 1, 1000));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    await settle();
    expect(row('web').getAttribute('aria-expanded')).toBe('true');
    fireEvent(line('web'), mouseAt('mousedown', 2, 1200));
    fireEvent(line('web'), mouseAt('click', 2, 1280));
    fireEvent(line('web'), mouseAt('dblclick', 2, 1280));
    expect(row('web').getAttribute('aria-expanded')).toBe('false');
    expect(bridge.select.mock.calls).toEqual([['w1']]);
    // A click now waits 240ms, a margin longer than that double click needed.
    fireEvent(line('web'), mouseAt('click', 1, 3000));
    act(() => {
      vi.advanceTimersByTime(230);
    });
    expect(row('web').getAttribute('aria-expanded')).toBe('false');
    act(() => {
      vi.advanceTimersByTime(10);
    });
    await settle();
    expect(row('web').getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves a workspace as it is after two clicks that are not a double click, and acts at once on a click elsewhere', async () => {
    const bridge = renderSection();
    fireEvent.click(line('web'), { detail: 1 });
    fireEvent.click(line('web'), { detail: 1 });
    await waitForSecondClick();
    expect(row('web').getAttribute('aria-expanded')).toBe('false');
    // A click on the other workspace lets the first click open its workspace at once.
    fireEvent.click(line('web'), { detail: 1 });
    fireEvent.click(line('api, Untrusted'), { detail: 1 });
    await settle();
    expect(row('web').getAttribute('aria-expanded')).toBe('true');
    expect(bridge.listFolder.mock.calls).toEqual([['w1', '']]);
  });

  it('opens a workspace into its folder tree, and reads each folder again when it opens again', async () => {
    const bridge = renderSection();
    fireEvent.click(line('web'));
    await waitForSecondClick();
    expect(bridge.select).not.toHaveBeenCalled();
    expect(row('web').getAttribute('aria-expanded')).toBe('true');
    const group = within(row('web')).getByRole('group');
    expect(
      within(group)
        .getAllByRole('treeitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['src', 'README.md']);
    expect(row('src').getAttribute('aria-level')).toBe('2');
    expect(row('README.md').getAttribute('aria-expanded')).toBeNull();
    // A folder opens with a click on its row, at once.
    fireEvent.click(line('src'));
    await settle();
    screen.getByRole('treeitem', { name: 'main.ts' });
    expect(bridge.listFolder.mock.calls).toEqual([
      ['w1', ''],
      ['w1', 'src'],
    ]);
    // Closing the workspace closes the folders inside it.
    fireEvent.click(line('web'));
    await waitForSecondClick();
    expect(screen.queryByRole('treeitem', { name: 'src' })).toBeNull();
    fireEvent.click(line('web'));
    await waitForSecondClick();
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(bridge.listFolder).toHaveBeenCalledTimes(3);
  });

  it('says when a folder cannot be read, and tries again when it is opened again', async () => {
    const bridge = renderSection();
    fireEvent.click(line('api, Untrusted'));
    await waitForSecondClick();
    const failed = row('api, Untrusted, Can’t open this folder');
    expect(failed.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(line('api, Untrusted, Can’t open this folder'));
    await waitForSecondClick();
    expect(bridge.listFolder).toHaveBeenCalledTimes(2);
  });

  it('moves through the rows with the arrow keys, Home and End', async () => {
    renderSection();
    row('web').focus();
    fireEvent.keyDown(row('web'), { key: 'ArrowRight' });
    await settle();
    fireEvent.keyDown(row('web'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row('src'));
    fireEvent.keyDown(row('src'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('README.md'));
    fireEvent.keyDown(row('README.md'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('api, Untrusted'));
    fireEvent.keyDown(row('api, Untrusted'), { key: 'Home' });
    expect(document.activeElement).toBe(row('web'));
    fireEvent.keyDown(row('web'), { key: 'End' });
    expect(document.activeElement).toBe(row('api, Untrusted'));
    // Tab reaches the row that has focus, rather than the selected workspace.
    expect(row('api, Untrusted').tabIndex).toBe(0);
    expect(row('web').tabIndex).toBe(-1);
    fireEvent.keyDown(row('api, Untrusted'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('README.md'));
    // Left goes out to the folder a row is in, and then closes it.
    fireEvent.keyDown(row('README.md'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('web'));
    fireEvent.keyDown(row('web'), { key: 'ArrowLeft' });
    expect(row('web').getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves keys with Command, Control or Option to the rest of the app', () => {
    const bridge = renderSection();
    const event = fireEvent.keyDown(row('web'), { key: 'Enter', metaKey: true });
    expect(event).toBe(true);
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it('opens a workspace’s menu with a secondary click on its row, but not from the rows inside it', async () => {
    const bridge = renderSection();
    fireEvent.contextMenu(line('web'));
    expect(bridge.showMenu.mock.calls).toEqual([['w1']]);
    fireEvent.click(line('web'));
    await waitForSecondClick();
    fireEvent.contextMenu(line('README.md'));
    expect(bridge.showMenu).toHaveBeenCalledOnce();
  });

  it('opens a terminal in the workspace’s folder when its menu asks for one', async () => {
    const bridge = fakeBridge();
    bridge.showMenu.mockResolvedValue('open-in-terminal');
    const onOpenInTerminal = vi.fn();
    render(<WorkspacesSection bridge={bridge} list={list} onOpenInTerminal={onOpenInTerminal} />);
    fireEvent.contextMenu(line('web'));
    await settle();
    expect(onOpenInTerminal.mock.calls).toEqual([[list.workspaces[0]?.path]]);
    bridge.showMenu.mockResolvedValue(null);
    fireEvent.contextMenu(line('web'));
    await settle();
    expect(onOpenInTerminal).toHaveBeenCalledOnce();
  });

  it('hands a press on a row to whoever drags it elsewhere, as a folder or a file by its absolute path, and never drags as the system does', async () => {
    const onPressItem = vi.fn<(item: TreeItem, press: PointerEvent<HTMLElement>) => void>();
    render(<WorkspacesSection bridge={fakeBridge()} list={list} onPressItem={onPressItem} />);
    expect(line('web').hasAttribute('draggable')).toBe(false);
    fireEvent.keyDown(row('web'), { key: 'ArrowRight' });
    await settle();
    for (const name of ['web', 'src', 'README.md']) {
      fireEvent.pointerDown(line(name), { pointerId: 1, button: 0 });
    }
    expect(onPressItem.mock.calls.map(([item]) => item)).toEqual([
      { kind: 'folder', path: '/Users/me/web' },
      { kind: 'folder', path: '/Users/me/web/src' },
      { kind: 'file', path: '/Users/me/web/README.md' },
    ]);
    expect(onPressItem.mock.calls[0]?.[1]).toMatchObject({ pointerId: 1, button: 0 });
  });

  it('opens a row elsewhere with ⌘↓, and a file with Return or Space too', async () => {
    const onOpenItem = vi.fn<(item: TreeItem) => void>();
    const bridge = fakeBridge();
    render(<WorkspacesSection bridge={bridge} list={list} onOpenItem={onOpenItem} />);
    expect(fireEvent.keyDown(row('web'), { key: 'ArrowDown', metaKey: true })).toBe(false);
    fireEvent.keyDown(row('web'), { key: 'ArrowRight' });
    await settle();
    fireEvent.keyDown(row('README.md'), { key: 'Enter' });
    fireEvent.keyDown(row('README.md'), { key: ' ' });
    // Return on a folder still opens and closes it in the tree.
    fireEvent.keyDown(row('src'), { key: 'Enter' });
    expect(onOpenItem.mock.calls).toEqual([
      [{ kind: 'folder', path: '/Users/me/web' }],
      [{ kind: 'file', path: '/Users/me/web/README.md' }],
      [{ kind: 'file', path: '/Users/me/web/README.md' }],
    ]);
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it('adds the folders dropped from the Finder, and leaves other drags alone', () => {
    const bridge = renderSection();
    const section = screen.getByRole('region', { name: 'Workspaces' });
    const folder = new File([], 'web');
    const files = { types: ['Files'], files: [folder] };
    expect(fireEvent.dragOver(section, { dataTransfer: files })).toBe(false);
    expect(section.className).toContain('outline-accent');
    fireEvent.drop(section, { dataTransfer: files });
    expect(bridge.addDropped.mock.calls).toEqual([[[folder]]]);
    expect(section.className).not.toContain('outline-accent');
    const text = { types: ['text/plain'], files: [] };
    expect(fireEvent.dragOver(section, { dataTransfer: text })).toBe(true);
    fireEvent.drop(section, { dataTransfer: text });
    expect(bridge.addDropped).toHaveBeenCalledOnce();
  });
});
