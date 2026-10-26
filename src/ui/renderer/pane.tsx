import type { ReactNode } from 'react';
import { StatusDot, type Status } from './status-dot';

interface PaneProps {
  title: string;
  // Shown after the title in a quieter style, such as the provider's name.
  detail: string;
  status: Status;
  // The status in words, for VoiceOver.
  statusLabel: string;
  // The other pane is dimmed while this one has focus.
  focused: boolean;
  onFocus: () => void;
  children: ReactNode;
}

// One pane of the main area: a header with the status, title and detail above a scrolling body.
export function Pane({
  title,
  detail,
  status,
  statusLabel,
  focused,
  onFocus,
  children,
}: PaneProps) {
  return (
    <section
      aria-label={title}
      onPointerDown={onFocus}
      onFocus={onFocus}
      className={`grid min-h-0 min-w-0 grid-rows-[44px_1fr] transition-opacity motion-reduce:transition-none ${focused ? '' : 'opacity-70'}`}
    >
      <header className="flex items-center gap-2.5 px-5 font-medium">
        <StatusDot status={status} />
        <span className="sr-only">{statusLabel}</span>
        <span className="truncate">{title}</span>
        <small className="text-xs font-normal text-faint">{detail}</small>
      </header>
      <div className="min-h-0 overflow-auto px-5 pt-2 pb-5 font-mono text-[12.5px]/[1.75] text-muted">
        {children}
      </div>
    </section>
  );
}
