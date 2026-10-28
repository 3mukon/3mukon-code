// How long a click on a workspace waits for the second press of a double click before it opens or
// closes the workspace. A wait shorter than the user's double clicks lets the first click act before
// the second press arrives, and the double click then has to put the tree back, which flickers; a
// longer one delays every single click. So the wait follows the user's own double clicks, measured
// from the first click to the second press: a margin longer than the slowest of the last few.

// Milliseconds.
const initial = 150;
const shortest = 100;
const longest = 400;
const margin = 40;
// How many of the latest double clicks count.
const kept = 5;

// The wait, in milliseconds, after double clicks whose second presses came these many milliseconds
// after their first clicks, oldest first.
export function clickWait(gaps: readonly number[]): number {
  if (gaps.length === 0) return initial;
  return Math.min(longest, Math.max(shortest, Math.max(...gaps.slice(-kept)) + margin));
}

// The gaps that count once a double click's second press has come this many milliseconds after its
// first click.
export function withGap(gaps: readonly number[], gap: number): number[] {
  return [...gaps, gap].slice(-kept);
}
