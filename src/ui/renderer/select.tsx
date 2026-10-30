import { ChevronDown } from './icons';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  // What the choice is about, in words, for VoiceOver and the tooltip.
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}

// A compact choice of one option: the chosen option's text in small type with a chevron after it,
// which keeps its left edge whatever the text's width, and whose list opens just below it, from that
// edge. A select in Chromium's customizable appearance lies over the text, invisible but for its focus
// ring and its list, a popover anchored to it; so the keyboard and VoiceOver handle it as any select,
// while the text truncates as the select's own would not.
export function Select({ label, value, options, onChange }: SelectProps) {
  const chosen = options.find((option) => option.value === value);
  return (
    <span className="relative flex min-w-0 items-center gap-0.5 rounded-md px-1 text-[11px] text-faint hover:text-ink">
      <span aria-hidden="true" className="min-w-0 truncate">
        {chosen?.label}
      </span>
      <ChevronDown className="size-3 shrink-0" />
      <select
        aria-label={label}
        title={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="absolute inset-0 m-0 min-h-0 min-w-0 rounded-md border-0 bg-transparent p-0 text-transparent [appearance:base-select] [&_option]:block [&_option]:truncate [&_option]:rounded-[4px] [&_option]:px-2 [&_option]:text-[13px] [&_option]:leading-6 [&_option]:text-ink [&_option:focus-visible]:bg-selected [&_option:focus-visible]:outline-none [&_option:hover]:bg-hover [&_option::checkmark]:mr-1.5 [&::picker-icon]:hidden [&::picker(select)]:mt-1 [&::picker(select)]:max-w-60 [&::picker(select)]:rounded-md [&::picker(select)]:border [&::picker(select)]:border-dashed [&::picker(select)]:border-menu-line [&::picker(select)]:paper [&::picker(select)]:p-1 [&::picker(select)]:shadow-none [&::picker(select)]:[appearance:base-select]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
