import { useId, type ReactNode } from 'react';
import { StateLabel, type StateTone } from './state-label';

// A setting whose items each have a state and a step of their own, such as the browsers agents use:
// its title and a line of detail, as a choice's have (Segmented), above its items in one outlined
// group, as a choice's options are, each on a row of its own with no line between them.
export function SettingGroup({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: ReactNode;
}) {
  const heading = useId();
  const described = useId();
  return (
    <section
      aria-labelledby={heading}
      {...(detail === undefined ? {} : { 'aria-describedby': described })}
      className="flex flex-col gap-1.5"
    >
      <div id={heading} className="font-medium text-ink">
        {label}
      </div>
      {detail !== undefined && (
        <p id={described} className="-mt-1 text-[11px] text-faint">
          {detail}
        </p>
      )}
      <div className="flex flex-col rounded-md border border-dashed border-menu-line p-0.5">
        {children}
      </div>
    </section>
  );
}

// One item of such a setting: its name, its state once it is set up right after the name, in the tone
// its kind of state takes (StateLabel), a line under the name saying what the item is, never its
// state, and at the row's right only buttons, the one that undoes the item where that can be done, or
// the one that sets it up.
export function SettingItem({
  name,
  state,
  stateTone = 'muted',
  line,
  children,
}: {
  name: string;
  state?: string;
  stateTone?: StateTone;
  line: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-2.5 py-[7px]">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-ink">{name}</span>
          {state !== undefined && <StateLabel text={state} tone={stateTone} />}
        </p>
        <p className="text-[11px] text-faint">{line}</p>
      </div>
      {children !== undefined && <div className="flex shrink-0 gap-1.5">{children}</div>}
    </div>
  );
}

// A line under a setting's items saying that a step did not go.
export function SettingProblem({ text }: { text: string }) {
  return (
    <p role="status" className="px-2.5 py-1 text-[11px] text-del">
      {text}
    </p>
  );
}
