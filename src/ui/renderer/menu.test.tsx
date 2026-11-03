import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MenuEntry } from '../shared/prompts';
import { Menu } from './menu';

// happy-dom has no popovers: showing and hiding one only marks it.
beforeAll(() => {
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
    this.dataset.shown = 'true';
  };
  HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) {
    delete this.dataset.shown;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entries: MenuEntry[] = [
  { id: 'trusted', label: 'Trusted', checked: true },
  { separator: true },
  { id: 'reveal', label: 'Reveal in Finder' },
  { id: 'remove', label: 'Remove Workspace' },
];

const items = () => [
  ...screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'),
];

describe('Menu', () => {
  it('shows its items as a menu of the window’s paper, with the focus on the first', () => {
    render(<Menu entries={entries} at={{ x: 40, y: 60 }} onClose={vi.fn()} />);
    const menu = screen.getByRole('menu');
    expect(menu.dataset.shown).toBe('true');
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(menu.className.split(' ')).toEqual(
      expect.arrayContaining(['paper', 'border-dashed', 'border-menu-line']),
    );
    expect(items().map((item) => [item.getAttribute('role'), item.textContent])).toEqual([
      ['menuitemcheckbox', 'Trusted'],
      ['menuitem', 'Reveal in Finder'],
      ['menuitem', 'Remove Workspace'],
    ]);
    expect(items()[0]?.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('separator').className).toContain('border-dashed');
    expect(document.activeElement).toBe(items()[0]);
    expect([menu.style.left, menu.style.top]).toEqual(['40px', '60px']);
  });

  it('opens above and to the left of its point where the window has no room below or to the right', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 200, 90),
    );
    render(
      <Menu
        entries={entries}
        at={{ x: window.innerWidth - 50, y: window.innerHeight - 20 }}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe(`${String(window.innerWidth - 250)}px`);
    expect(menu.style.top).toBe(`${String(window.innerHeight - 110)}px`);
  });

  it('moves between its items with the arrow keys, Home, End and a letter, as the pointer does', () => {
    render(<Menu entries={entries} at={{ x: 0, y: 0 }} onClose={vi.fn()} />);
    const menu = screen.getByRole('menu');
    const press = (key: string, shiftKey = false) => {
      fireEvent.keyDown(document.activeElement ?? menu, { key, shiftKey });
      return document.activeElement?.textContent;
    };
    expect(press('ArrowDown')).toBe('Reveal in Finder');
    expect(press('ArrowDown')).toBe('Remove Workspace');
    expect(press('ArrowDown')).toBe('Trusted');
    expect(press('ArrowUp')).toBe('Remove Workspace');
    expect(press('Home')).toBe('Trusted');
    expect(press('End')).toBe('Remove Workspace');
    expect(press('r')).toBe('Reveal in Finder');
    expect(press('r')).toBe('Remove Workspace');
    // Tab stays in the menu, as macOS's menus keep the keyboard.
    expect(press('Tab')).toBe('Trusted');
    expect(press('Tab', true)).toBe('Remove Workspace');
    fireEvent.pointerMove(screen.getByRole('menuitem', { name: 'Reveal in Finder' }));
    expect(document.activeElement?.textContent).toBe('Reveal in Finder');
  });

  it('closes with the item chosen, once', () => {
    const chosen = vi.fn();
    render(<Menu entries={entries} at={{ x: 0, y: 0 }} onClose={chosen} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Workspace' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(chosen.mock.calls).toEqual([['remove']]);
  });

  it('stays open as the press that asked for it is released beside it, and as the pointer is pressed in it', () => {
    const onClose = vi.fn();
    render(<Menu entries={entries} at={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.pointerUp(document.body, { button: 2 });
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Reveal in Finder' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('menu').dataset.shown).toBe('true');
  });

  it('closes without a choice at Escape, a press or the wheel beside it, and as the window loses the focus or changes size', () => {
    const close: [string, (target: HTMLElement) => void][] = [
      ['Escape', (target) => fireEvent.keyDown(target, { key: 'Escape' })],
      ['a press beside it', () => fireEvent.pointerDown(document.body)],
      ['the wheel beside it', () => fireEvent.wheel(document.body)],
      ['the window’s blur', () => fireEvent.blur(window)],
      ['a resize', () => fireEvent(window, new Event('resize'))],
    ];
    for (const [name, closeBy] of close) {
      const onClose = vi.fn();
      const { unmount } = render(<Menu entries={entries} at={{ x: 0, y: 0 }} onClose={onClose} />);
      closeBy(screen.getByRole('menuitem', { name: 'Reveal in Finder' }));
      expect([name, onClose.mock.calls]).toEqual([name, [[null]]]);
      unmount();
    }
  });
});
