import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { FolderListing, WorkspaceList, WorkspacesBridge } from '../shared/workspaces';
import { WorkspacesSection } from './workspaces-section';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

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
    showMenu: vi.fn<WorkspacesBridge['showMenu']>(() => Promise.resolve()),
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
const chevron = (name: string) => line(name).firstElementChild as HTMLElement;
const settle = () => act(() => Promise.resolve());

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

  it('selects a workspace with a click, Return or Space', () => {
    const bridge = renderSection();
    fireEvent.click(line('api, Untrusted'));
    fireEvent.keyDown(row('api, Untrusted'), { key: 'Enter' });
    fireEvent.keyDown(row('web'), { key: ' ' });
    expect(bridge.select.mock.calls).toEqual([['w2'], ['w2'], ['w1']]);
  });

  it('opens a workspace into its folder tree, and reads each folder again when it opens again', async () => {
    const bridge = renderSection();
    fireEvent.click(chevron('web'));
    await settle();
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
    // A folder opens with a click on its row.
    fireEvent.click(line('src'));
    await settle();
    screen.getByRole('treeitem', { name: 'main.ts' });
    expect(bridge.listFolder.mock.calls).toEqual([
      ['w1', ''],
      ['w1', 'src'],
    ]);
    // Closing the workspace closes the folders inside it.
    fireEvent.click(chevron('web'));
    expect(screen.queryByRole('treeitem', { name: 'src' })).toBeNull();
    fireEvent.click(chevron('web'));
    await settle();
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(bridge.listFolder).toHaveBeenCalledTimes(3);
  });

  it('says when a folder cannot be read, and tries again when it is opened again', async () => {
    const bridge = renderSection();
    fireEvent.click(chevron('api, Untrusted'));
    await settle();
    const failed = row('api, Untrusted, Can’t open this folder');
    expect(failed.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chevron('api, Untrusted, Can’t open this folder'));
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
    fireEvent.click(chevron('web'));
    await settle();
    fireEvent.contextMenu(line('README.md'));
    expect(bridge.showMenu).toHaveBeenCalledOnce();
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
