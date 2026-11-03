import { useEffectEvent, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { MenuEntry } from '../shared/prompts';
import { Check } from './icons';

// How far a menu keeps from the window's edges.
const EDGE = 8;

interface MenuProps {
  entries: MenuEntry[];
  // Where the menu opens, in the window's coordinates, such as the pointer's place.
  at: { x: number; y: number };
  // Called once, with the chosen item's id, or null when the menu closes without a choice.
  onClose: (chosen: string | null) => void;
}

// A menu at a point, as a sheet of the window's paper under a dashed line, as the selects' lists are
// drawn: it opens below and to the right of the point, or above and to the left where the window has
// no room, with the keyboard focus on its first item. The arrow keys, Home and End move between the
// items, as the pointer does, and a letter to the next item it begins; a click, Return or Space
// chooses one. As macOS's menus do, it closes without a choice at Escape, at a press of the pointer or
// a turn of the wheel beside it, and as the window loses the focus or changes size; the release of the
// press that asked for it, which may come once the menu shows, leaves it open. VoiceOver hears it as
// a menu of items, a checked one as checked.
export function Menu({ entries, at, onClose }: MenuProps) {
  const sheet = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const checkable = entries.some((entry) => 'checked' in entry);

  const close = (chosen: string | null) => {
    if (closed.current) return;
    closed.current = true;
    onClose(chosen);
  };
  const dismiss = useEffectEvent(() => {
    close(null);
  });

  useLayoutEffect(() => {
    const element = sheet.current;
    if (element === null) return;
    element.showPopover();
    const { width, height } = element.getBoundingClientRect();
    const left = at.x + width + EDGE > window.innerWidth ? at.x - width : at.x;
    const top = at.y + height + EDGE > window.innerHeight ? at.y - height : at.y;
    element.style.left = `${String(Math.max(EDGE, left))}px`;
    element.style.top = `${String(Math.max(EDGE, top))}px`;
    itemsOf(element)[0]?.focus();
    // Its own closing, which the browser's would do at the release of the press that asked for it.
    const beside = (event: Event) => {
      if (!(event.target instanceof Node && element.contains(event.target))) dismiss();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener('pointerdown', beside, true);
    document.addEventListener('wheel', beside, { capture: true, passive: true });
    document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', beside, true);
      document.removeEventListener('wheel', beside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      element.hidePopover();
    };
  }, [at]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemsOf(event.currentTarget);
    const current = items.findIndex((item) => item === document.activeElement);
    const step = (by: number) => items.at((current + by + items.length) % items.length);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) next = step(1);
    else if (event.key === 'ArrowUp' || event.key === 'Tab') next = step(-1);
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLocaleLowerCase();
      const after = [...items.slice(current + 1), ...items.slice(0, current + 1)];
      next = after.find((item) => item.textContent.trim().toLocaleLowerCase().startsWith(letter));
    } else {
      return;
    }
    event.preventDefault();
    next?.focus();
  };

  return (
    <div
      ref={sheet}
      popover="manual"
      role="menu"
      onKeyDown={onKeyDown}
      className="inset-auto m-0 max-w-72 min-w-40 rounded-md border border-dashed border-menu-line paper p-1 text-[13px] leading-6 text-ink"
    >
      {entries.map((entry, index) =>
        'separator' in entry ? (
          <div
            key={`separator-${String(index)}`}
            role="separator"
            className="mx-1 my-1 border-t border-dashed border-menu-line"
          />
        ) : (
          <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            {...(entry.checked === undefined ? {} : { 'aria-checked': entry.checked })}
            tabIndex={-1}
            onPointerMove={(event) => {
              event.currentTarget.focus();
            }}
            onClick={() => {
              close(entry.id);
            }}
            className="flex w-full items-center gap-1.5 truncate rounded-[4px] px-2 text-left outline-none hover:bg-hover focus:bg-selected"
          >
            {checkable && (
              <span className="grid size-3.5 shrink-0 place-items-center">
                {entry.checked === true && <Check className="size-3.5" />}
              </span>
            )}
            <span className="min-w-0 truncate">{entry.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

// The menu's items, in order.
function itemsOf(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
}
