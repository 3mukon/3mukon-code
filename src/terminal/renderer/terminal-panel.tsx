import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { useEffect, useRef } from 'react';
import type { TerminalViews } from './terminal-views';

// A terminal in a panel: its emulator, on the window's own paper, which follows the panel's size,
// takes the keyboard and the pointer, copies the selection with ⌘C, pastes with ⌘V and opens a web
// link with ⌘-click. Moving or splitting the panel keeps what the terminal shows.
export function TerminalPanel({ views, id }: { views: TerminalViews; id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const hide = views.show(id, element);
    const observer = new ResizeObserver(() => {
      views.fit(id);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      hide();
    };
  }, [views, id]);
  return (
    <div ref={host} className="terminal-paper h-full min-h-0 w-full overflow-hidden px-2 py-1.5" />
  );
}
