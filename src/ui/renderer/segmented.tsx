import { useId, type KeyboardEvent } from 'react';

export interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedProps {
  // What the choice is about, shown above it and naming it for VoiceOver.
  label: string;
  // Said under the label, in quieter type.
  detail?: string;
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
}

// A choice of one among a few options, as a row of them under a dashed line on the window's paper,
// the chosen one drawn in ink as a question's default answer is. It is a radio group: Tab reaches the
// chosen option, and the arrow keys, Home and End choose another.
export function Segmented({ label, detail, value, options, onChange }: SegmentedProps) {
  const heading = useId();
  const described = useId();
  const chosen = options.findIndex((option) => option.value === value);
  // Tab reaches the chosen option, or the first while none is.
  const reached = chosen === -1 ? 0 : chosen;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    const targets: Partial<Record<string, number>> = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    };
    const next = targets[event.key];
    const option = next === undefined ? undefined : options[next];
    if (next === undefined || option === undefined) return;
    event.preventDefault();
    onChange(option.value);
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    buttons?.[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div id={heading} className="font-medium text-ink">
        {label}
      </div>
      {detail !== undefined && (
        <p id={described} className="-mt-1 text-[11px] text-faint">
          {detail}
        </p>
      )}
      <div
        role="radiogroup"
        aria-labelledby={heading}
        aria-describedby={detail === undefined ? undefined : described}
        className="flex w-max max-w-full flex-wrap gap-0.5 rounded-md border border-dashed border-menu-line p-0.5"
      >
        {options.map((option, index) => {
          const checked = index === chosen;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === reached ? 0 : -1}
              onClick={() => {
                onChange(option.value);
              }}
              onKeyDown={(event) => {
                onKeyDown(event, index);
              }}
              className={`rounded-[4px] px-3 text-[12px] leading-6 ${checked ? 'bg-ink text-frame' : 'text-muted hover:bg-hover hover:text-ink'}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
