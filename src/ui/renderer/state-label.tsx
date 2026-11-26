// How a state reads wherever the app names one beside what it belongs to, as a setting's items and the
// Accounts panel's providers do: working, as Allowed or signed in, in the run colour; one that cannot
// work, in the colour of failure; one that needs something the app cannot do, as a newer browser, in
// the wait colour; one that waits on something else, or on the step a button beside it takes, quietly.
export const stateColors = {
  muted: 'text-faint',
  success: 'text-run',
  error: 'text-del',
  attention: 'text-wait',
} as const;

export type StateTone = keyof typeof stateColors;

// A state in small type and its tone's colour, right after the name of what it belongs to.
export function StateLabel({ text, tone = 'muted' }: { text: string; tone?: StateTone }) {
  return <span className={`text-[11px] ${stateColors[tone]}`}>{text}</span>;
}
