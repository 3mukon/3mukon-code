// The divider keeps each of the two panes at least this many pixels wide.
export const minPaneWidth = 260;

// Clamps the first pane's share of the width so that both panes keep minPaneWidth. When the panes are
// too narrow for that, they share the width equally.
export function clampSplit(split: number, width: number): number {
  if (width < 2 * minPaneWidth) return 0.5;
  const smallest = minPaneWidth / width;
  return Math.min(Math.max(split, smallest), 1 - smallest);
}
