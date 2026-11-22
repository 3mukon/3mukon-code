import type { ReactNode } from 'react';

// A short fact in a dashed outline, in small muted type, such as how a page is shared or whether work
// runs in the background.
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-dashed border-line px-[5px] text-[11px] whitespace-nowrap text-muted">
      {children}
    </span>
  );
}
