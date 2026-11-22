import type { MouseEvent } from 'react';

// A plain button, as the app's notices, settings and panels draw one: its label in the ink under a
// thin line, in the type it stands in, at 12px; a small one, as in a line of small type above the
// composer, at 11px. Its click comes with the button, for what opens beside it. Where its label alone
// would not say what it acts on, as End among several grants, VoiceOver hears what `spoken` says.
export function Button({
  label,
  spoken,
  small = false,
  disabled = false,
  onClick,
}: {
  label: string;
  spoken?: string;
  small?: boolean;
  disabled?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      {...(spoken === undefined ? {} : { 'aria-label': spoken })}
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 border border-line whitespace-nowrap text-ink enabled:hover:bg-hover disabled:text-faint ${small ? 'rounded-sm px-[7px] text-[11px]' : 'rounded-md px-2.5 py-0.5 text-[12px]'}`}
    >
      {label}
    </button>
  );
}
