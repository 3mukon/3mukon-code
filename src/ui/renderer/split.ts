// While the space allows, each part of a split keeps at least this many pixels: panels side by side
// this wide, stacked panels this tall.
export const minPanelWidth = 200;
export const minPanelHeight = 120;

// Clamps the first part's share of a split's length so that both parts keep the smallest size. When
// the length is too short for that, they share it equally.
export function clampRatio(ratio: number, length: number, smallest: number): number {
  if (length < 2 * smallest) return 0.5;
  const share = smallest / length;
  return Math.min(Math.max(ratio, share), 1 - share);
}
