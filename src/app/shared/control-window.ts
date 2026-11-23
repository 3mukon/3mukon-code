export const controlChannels = {
  snapshot: 'control-window:snapshot',
  ready: 'control-window:ready',
  state: 'control-window:state',
};

// The control, in points.
export const CONTROL_SIZE = { width: 560, height: 48 };

// What the page draws, one under another: the control, then the control as it is with the pointer over
// its buttons and with them pressed, for main to take each button's pictures from.
export const looks = ['rest', 'hover', 'pressed'] as const;

// The page marks its picture with the revision it shows, so that main can tell a picture of it from
// an earlier one: cells of one point along the window's top edge, which the control leaves free, the
// first always opaque, then one for each bit of the revision, the lowest first.
export const REVISION_BITS = 31;
export function marked(revision: number, cell: number): boolean {
  return cell === 0 || ((revision >> (cell - 1)) & 1) === 1;
}
