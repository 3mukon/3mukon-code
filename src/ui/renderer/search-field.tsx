import { useRef } from 'react';
import { Search, X } from './icons';

interface SearchFieldProps {
  // What the field searches, naming it for VoiceOver.
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  // Names the button that clears the query, for VoiceOver and the tooltip.
  clearLabel: string;
  // Closes the field, where it can close: Escape asks for it, and so does leaving it empty.
  onClose?: () => void;
  // Small type over a dashed line, to sit in a heading's row without changing its height; otherwise a
  // box of the panel's width.
  compact?: boolean;
  autoFocus?: boolean;
}

// A field to search with, on the window's paper: a magnifying glass, the query, and while there is one
// a button that clears it. Escape clears the query, and closes the field where it can close.
export function SearchField({
  label,
  placeholder,
  value,
  onChange,
  clearLabel,
  onClose,
  compact = false,
  autoFocus = false,
}: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`flex min-w-0 items-center gap-1 border-dashed border-menu-line ${compact ? '-my-0.5 h-5 flex-1 border-b px-0.5 text-[11px]' : 'h-7 rounded-md border px-2'}`}
    >
      <Search className={`${compact ? 'size-3' : 'size-3.5'} shrink-0 text-faint`} />
      <input
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        // The field takes the focus as it opens, since the user opened it to type.
        autoFocus={autoFocus}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onChange('');
          onClose?.();
        }}
        onBlur={() => {
          if (value === '') onClose?.();
        }}
        className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-placeholder [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== '' && (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          // The query's field keeps the focus, so that clearing never closes it.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
          className="grid size-4 shrink-0 place-items-center rounded-sm text-faint hover:bg-hover hover:text-ink"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
