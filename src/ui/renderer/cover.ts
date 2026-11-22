// What lies over the window's page for a while: a menu, a popover, a tooltip, a dialog or a drag,
// each registered by the part that shows it, for as long as it shows. What the window shows over its
// page from outside it, as a web page in a panel, cannot lie under such things, so it asks whether
// one meets its place, and hears whenever they change.
export type Cover = Element | 'window';

const covers = new Set<{ cover: Cover }>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

// Registers what lies over the page, the whole window for a modal dialog or a drag, until the
// function returned is called. Listeners hear at once, and again after the next frame, by when a menu
// has its place.
export function addCover(cover: Cover): () => void {
  const entry = { cover };
  covers.add(entry);
  changed();
  const frame = requestAnimationFrame(changed);
  return () => {
    cancelAnimationFrame(frame);
    if (covers.delete(entry)) changed();
  };
}

// Whether anything registered lies over a box, in the window's CSS pixels.
export function isCovered(box: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): boolean {
  for (const { cover } of covers) {
    if (cover === 'window') return true;
    const rect = cover.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < box.right &&
      rect.right > box.left &&
      rect.top < box.bottom &&
      rect.bottom > box.top
    )
      return true;
  }
  return false;
}

// Hears each change to what lies over the page, until the function returned is called.
export function onCoversChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
