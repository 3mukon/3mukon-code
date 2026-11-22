import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { imageUrl } from '../../sessions/shared/images';
import { addCover, isCovered, onCoversChange } from '../../ui/renderer/cover';
import type { BrowserTabRef } from '../shared/browser';
import type { BrowserViewDisplay, BrowserViewPlacement, BrowserViews } from '../shared/view';

// How long the page waits before asking again to be shown, while main has not yet heard that its
// panel opened, or the tab has no page yet: a few tries, each twice as late as the last.
const BIND_RETRIES = [50, 100, 200, 400, 800, 1600];
// How many times in a row the page borrows its tab's page again after main has let it go, before it
// leaves it at the paper.
const REBINDS = 3;
const FILE_DRAG_HANDOFF_MS = 1_000;

// A tab's live page in its panel (ADR-0027): main lays the tab's own page over this box, as the
// panel shows it, so that moving, hiding or showing the panel again keeps the page as it was. The box
// tells main where it is whenever that changes; while a menu, popover, tooltip, dialog or drag lies
// over it, the page makes way, showing a still frame of itself or the paper with its title and
// address, and turns live again once nothing does; and while its panel has no focus, it dims as an
// unfocused panel fades, and the click that focuses the panel only focuses it. A Chrome
// tab's page is never lent: its panel shows still frames of it, faded as a preview, asked for anew
// each second, and tells whoever composes it when the frame it shows was taken.
export function BrowserPageView({
  views,
  owner,
  presentation,
  tab,
  title,
  address,
  previewRevision,
  focused,
  onFocus,
  onFrame,
}: {
  views: BrowserViews;
  // The session that owns the tab, and the presentation whose panel shows it.
  owner: string;
  presentation: string;
  tab: BrowserTabRef;
  // What the paper says while the page cannot show.
  title: string;
  address: string;
  // For a Chrome tab, what its frames follow: its document and its viewport.
  previewRevision?: string;
  // Whether the panel has the focus; without it, the page dims.
  focused: boolean;
  // The user's click on the dimmed page, which focuses its panel.
  onFocus: () => void;
  // When the frame it shows was taken, or null while it shows none.
  onFrame?: (capturedAt: number | null) => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const { id: tabId, generation } = tab;
  const [binding, setBinding] = useState<string | null>(null);
  const [display, setDisplay] = useState<BrowserViewDisplay>({ kind: 'paper' });
  // Bumped to bind again once main has let a binding go.
  const [bindings, setBindings] = useState(0);
  const revision = useRef(0);
  const placed = useRef<string | null>(null);
  const rebinds = useRef(0);
  const latest = useRef({ focused, onFocus, onFrame });
  useLayoutEffect(() => {
    latest.current = { focused, onFocus, onFrame };
  });
  const shownAt = display.kind === 'frame' ? display.capturedAt : null;
  useEffect(() => {
    latest.current.onFrame?.(shownAt);
  }, [shownAt]);

  // Asks main to lend the tab's page to this panel, again as long as main has not heard of the panel
  // yet, and lets it go when the box goes.
  useEffect(() => {
    let current = true;
    let bound: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ref: BrowserTabRef = { id: tabId, kind: 'browser-tab', generation };
    const attempt = (tries: number) => {
      views.bind(owner, presentation, ref).then(
        (outcome) => {
          if (!current) {
            if (outcome.status === 'verified') void views.release(outcome.value);
            return;
          }
          if (outcome.status === 'verified') {
            bound = outcome.value;
            placed.current = null;
            setBinding(outcome.value);
            return;
          }
          const delay = BIND_RETRIES[tries];
          const later =
            outcome.status === 'refused' &&
            (outcome.code === 'not-found' || outcome.code === 'background-unavailable');
          if (later && delay !== undefined) {
            timer = setTimeout(() => {
              attempt(tries + 1);
            }, delay);
          }
        },
        (error: unknown) => {
          console.error('The page could not be shown in its panel:', error);
        },
      );
    };
    attempt(0);
    return () => {
      current = false;
      clearTimeout(timer);
      setBinding(null);
      setDisplay({ kind: 'paper' });
      if (bound !== null) void views.release(bound);
    };
  }, [views, owner, presentation, tabId, generation, bindings]);

  // Tells main where the page goes, whether something lies over it and how it dims, whenever any of
  // that changes, each placement newer than the last.
  const place = (refresh = false) => {
    const element = box.current;
    if (binding === null || element === null) return;
    const rect = element.getBoundingClientRect();
    const bounds =
      rect.width > 0 && rect.height > 0
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        : null;
    const placement: BrowserViewPlacement = {
      bounds,
      covered: bounds !== null && isCovered(rect),
      dim: latest.current.focused ? null : paperColour(),
    };
    const key = JSON.stringify([placement, previewRevision]);
    if (key === placed.current && (!refresh || placement.covered || !bounds)) return;
    placed.current = key;
    const mine = ++revision.current;
    views.place(binding, mine, placement).then(
      (outcome) => {
        if (mine !== revision.current) return;
        if (outcome.status === 'verified') {
          rebinds.current = 0;
          setDisplay(outcome.value);
        } else if (
          outcome.status === 'refused' &&
          outcome.code === 'stale-target' &&
          rebinds.current++ < REBINDS
        ) {
          setBindings((count) => count + 1);
        }
      },
      (error: unknown) => {
        console.error('The page could not be placed in its panel:', error);
      },
    );
  };
  const placeLatest = useRef(place);
  useLayoutEffect(() => {
    placeLatest.current = place;
    place();
  });
  const external = previewRevision !== undefined;
  useEffect(() => {
    if (!external) return;
    // A preview asks for a fresh frame each second; main keeps the last one where it cannot.
    const timer = setInterval(() => {
      placeLatest.current(true);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [external]);
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const again = () => {
      placeLatest.current();
    };
    const resized = new ResizeObserver(again);
    resized.observe(element);
    const appearance = matchMedia('(prefers-color-scheme: dark)');
    window.addEventListener('resize', again);
    appearance.addEventListener('change', again);
    const stopCovers = onCoversChange(again);
    return () => {
      resized.disconnect();
      window.removeEventListener('resize', again);
      appearance.removeEventListener('change', again);
      stopCovers();
    };
  }, []);

  // The click that focused the dimmed page, which main took for the panel.
  useEffect(
    () =>
      views.onFocus((focusedBinding) => {
        if (focusedBinding === binding) latest.current.onFocus();
      }),
    [views, binding],
  );

  useEffect(() => {
    if (binding === null) return;
    let uncover: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = views.onFileDrag((source) => {
      if (source !== binding) return;
      // Keep the view parked while the app's normal dragover handler takes the drag. Its cover
      // lives through the drop. If the drag leaves first, let the parked view return by itself.
      uncover ??= addCover('window');
      clearTimeout(timer);
      timer = setTimeout(() => {
        uncover?.();
        uncover = undefined;
      }, FILE_DRAG_HANDOFF_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
      uncover?.();
    };
  }, [views, binding]);

  return (
    <div ref={box} className="absolute inset-0">
      {display.kind === 'frame' ? (
        <img
          src={imageUrl(display.frame)}
          alt={external ? t('browser.panel.preview') : ''}
          draggable={false}
          className={
            external ? 'size-full object-contain object-top saturate-60' : 'size-full object-fill'
          }
        />
      ) : (
        display.kind === 'paper' && (
          <div className="flex size-full flex-col items-center justify-center paper px-6 text-center">
            <p className="max-w-full truncate text-[12px] text-ink">{title}</p>
            <p className="max-w-full truncate font-mono text-[11px] text-faint">{address}</p>
          </div>
        )
      )}
    </div>
  );
}

// The window's paper as #RRGGBB, which main lays over an unfocused panel's page so that it fades as
// the panel's other parts do.
function paperColour(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--frame').trim();
}
