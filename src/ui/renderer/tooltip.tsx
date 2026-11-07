import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// How long the pointer or the keyboard's focus rests on an element before its tooltip shows, and how
// soon after one hides the next shows at once, so that moving along a row of icons names each in turn.
export const TOOLTIP_DELAY_MS = 500;
const WARM_MS = 300;
// Where an element's title waits while the pointer is over it.
const ASIDE = 'data-tooltip-title';
// How far the tooltip keeps from its element and from the window's edges.
const GAP = 6;
const MARGIN = 8;
// How often a shown tooltip checks that its element is still there.
const CHECK_MS = 250;

interface Shown {
  element: Element;
  text: string;
}

// The window's tooltips, drawn in the page in the app's own look rather than macOS's, which Electron
// shows only now and then (ADR-0021): a sheet of the window's paper under a dashed line, below the
// element whose `title` the pointer rests on, or above it near the window's foot, and for the element
// the keyboard focuses. Elements keep their `title`, which names them for VoiceOver and for the tests;
// while the pointer is over one, its title waits aside, so that macOS's own tooltip does not show as
// well, and it comes back as the pointer leaves. A press, the wheel, Escape, the window losing the
// focus or the element going hides the tooltip; one pressed shows none again until the pointer leaves
// it. The tooltips show only while `enabled`, the Tooltips setting, which starts off; while it is off,
// the title of the element under the pointer still waits aside, so that no tooltip of macOS's shows in
// their stead. Mounted once, by whoever composes the window.
export function TooltipHost({ enabled }: { enabled: boolean }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = document.defaultView ?? window;
    // The element whose tooltip shows or is about to, and whether the pointer or the keyboard chose it.
    let target: Element | null = null;
    let byPointer = false;
    let visible = false;
    let hiddenAt = Number.NEGATIVE_INFINITY;
    // The element last pressed, which shows no tooltip until the pointer leaves it.
    let pressed: Element | null = null;
    // Whether the last input came from the keyboard, so that only its focus shows a tooltip.
    let keyboard = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let check: ReturnType<typeof setInterval> | undefined;
    let watch: MutationObserver | null = null;

    const titled = (node: EventTarget | null): Element | null =>
      node instanceof Element ? node.closest(`[title], [${ASIDE}]`) : null;

    // Sets the element's title aside and says what it is, also when React has set it again meanwhile,
    // as a label that changes does, such as Copy becoming Copied.
    const setAside = (element: Element): string | null => {
      const title = element.getAttribute('title');
      if (title === null) return element.getAttribute(ASIDE);
      element.removeAttribute('title');
      element.setAttribute(ASIDE, title);
      return title;
    };
    const giveBack = (element: Element) => {
      const title = element.getAttribute(ASIDE);
      if (title === null) return;
      element.removeAttribute(ASIDE);
      if (!element.hasAttribute('title')) element.setAttribute('title', title);
    };

    const hide = () => {
      clearTimeout(timer);
      clearInterval(check);
      watch?.disconnect();
      watch = null;
      if (target !== null && byPointer) giveBack(target);
      target = null;
      if (visible) {
        visible = false;
        hiddenAt = Date.now();
        setShown(null);
      }
    };

    const start = (element: Element, pointer: boolean) => {
      hide();
      // While the tooltips are off, the keyboard's focus has nothing to show.
      if (!enabled && !pointer) return;
      const text = pointer ? setAside(element) : element.getAttribute('title');
      if (text === null || text.trim() === '') {
        if (pointer) giveBack(element);
        return;
      }
      target = element;
      byPointer = pointer;
      if (pointer) {
        watch = new MutationObserver(() => {
          const relabelled = setAside(element);
          if (relabelled !== null && visible) setShown({ element, text: relabelled });
        });
        watch.observe(element, { attributes: true, attributeFilter: ['title'] });
      }
      // While they are off, the pointer's element keeps its title aside until the pointer leaves it,
      // and nothing shows.
      if (!enabled) return;
      const reveal = () => {
        const current = pointer ? element.getAttribute(ASIDE) : element.getAttribute('title');
        if (target !== element || !element.isConnected || current === null) return;
        visible = true;
        setShown({ element, text: current });
        check = setInterval(() => {
          if (!element.isConnected) hide();
        }, CHECK_MS);
      };
      if (Date.now() - hiddenAt < WARM_MS) reveal();
      else timer = setTimeout(reveal, TOOLTIP_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const element = titled(event.target);
      if (element !== pressed) pressed = null;
      if (element === null || element === pressed) {
        if (target !== null && byPointer) hide();
        return;
      }
      if (element !== target || !byPointer) start(element, true);
    };
    const onPointerOut = (event: PointerEvent) => {
      // Leaving the window.
      if (event.relatedTarget === null && target !== null && byPointer) hide();
    };
    const onPointerDown = (event: PointerEvent) => {
      keyboard = false;
      pressed = titled(event.target);
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      keyboard = true;
      if (event.key === 'Escape') hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!keyboard) return;
      const element = event.target;
      if (element instanceof Element && element.hasAttribute('title')) start(element, false);
      else if (target !== null && !byPointer) hide();
    };
    const onFocusOut = () => {
      if (target !== null && !byPointer) hide();
    };

    const capture = { capture: true } as const;
    const passive = { capture: true, passive: true } as const;
    document.addEventListener('pointerover', onPointerOver, capture);
    document.addEventListener('pointerout', onPointerOut, capture);
    document.addEventListener('pointerdown', onPointerDown, capture);
    document.addEventListener('keydown', onKeyDown, capture);
    document.addEventListener('focusin', onFocusIn, capture);
    document.addEventListener('focusout', onFocusOut, capture);
    document.addEventListener('wheel', hide, passive);
    document.addEventListener('scroll', hide, passive);
    view.addEventListener('blur', hide);
    view.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('pointerover', onPointerOver, capture);
      document.removeEventListener('pointerout', onPointerOut, capture);
      document.removeEventListener('pointerdown', onPointerDown, capture);
      document.removeEventListener('keydown', onKeyDown, capture);
      document.removeEventListener('focusin', onFocusIn, capture);
      document.removeEventListener('focusout', onFocusOut, capture);
      document.removeEventListener('wheel', hide, passive);
      document.removeEventListener('scroll', hide, passive);
      view.removeEventListener('blur', hide);
      view.removeEventListener('resize', hide);
      hide();
    };
  }, [enabled]);

  // Below the element and centred on it, or above it where the window's foot leaves no room, and always
  // inside the window.
  useLayoutEffect(() => {
    const tip = box.current;
    if (shown === null || tip === null) return;
    const anchor = shown.element.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    const left = Math.min(
      Math.max(anchor.left + anchor.width / 2 - width / 2, MARGIN),
      Math.max(MARGIN, clientWidth - width - MARGIN),
    );
    const below = anchor.bottom + GAP;
    const top =
      below + height > clientHeight - MARGIN ? Math.max(MARGIN, anchor.top - GAP - height) : below;
    tip.style.left = `${String(Math.round(left))}px`;
    tip.style.top = `${String(Math.round(top))}px`;
  }, [shown]);

  return shown === null
    ? null
    : createPortal(
        <div
          ref={box}
          data-tooltip=""
          aria-hidden="true"
          className="paper pointer-events-none fixed top-0 left-0 z-50 max-w-[22rem] rounded-md border border-dashed border-menu-line px-2 py-1 text-[11px] leading-4 break-words whitespace-pre-line text-ink"
        >
          {shown.text}
        </div>,
        document.body,
      );
}
