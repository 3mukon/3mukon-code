import type { DragEvent, ReactNode, Ref } from 'react';
import { X } from './icons';
import { StatusDot, type Status } from './status-dot';

interface PaneProps {
  title: string;
  // Shown after the title in a quieter style, such as the provider's name or a folder's name.
  detail?: string;
  // The detail in full, as its tooltip, such as a path.
  detailTitle?: string;
  status?: Status;
  // The status in words, for VoiceOver.
  statusLabel?: string;
  // The other panes are dimmed while this one has focus.
  focused: boolean;
  onFocus: () => void;
  // Closes the pane from its header; the label names the button for VoiceOver and the tooltip.
  onClose?: () => void;
  closeLabel?: string;
  // The header lies in the window's title bar, and its empty part moves the window, as a title bar
  // does.
  inTitleBar?: boolean;
  // The header leaves room at its start for macOS's window buttons, which lie over it.
  clearsWindowButtons?: boolean;
  // Dragging the pane by its title and detail, to move it.
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  // The pane's own element, for a parent that moves focus to it.
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
}

// One pane of the main area: a header with the status, title, detail and close button, as tall as the
// title bar, above a scrolling body. The pane takes focus from the keyboard as a whole, and marks
// itself as the current one while it has focus. Its title and detail are its handle, by which it
// drags when its parent lets it; in the title bar, they and the button still take clicks.
export function Pane({
  title,
  detail,
  detailTitle,
  status,
  statusLabel,
  focused,
  onFocus,
  onClose,
  closeLabel,
  inTitleBar = false,
  clearsWindowButtons = false,
  onDragStart,
  onDragEnd,
  ref,
  children,
}: PaneProps) {
  return (
    <section
      ref={ref}
      aria-label={title}
      aria-current={focused ? 'true' : undefined}
      tabIndex={-1}
      onPointerDown={onFocus}
      onFocus={onFocus}
      className={`grid min-h-0 min-w-0 grid-rows-[40px_1fr] outline-none transition-opacity motion-reduce:transition-none ${focused ? '' : 'opacity-70'}`}
    >
      <header
        className={`flex min-w-0 items-center gap-2.5 pr-3 font-medium ${inTitleBar ? '[-webkit-app-region:drag]' : ''} ${clearsWindowButtons ? 'pl-[84px]' : 'pl-5'}`}
      >
        {status !== undefined && <StatusDot status={status} />}
        {statusLabel !== undefined && <span className="sr-only">{statusLabel}</span>}
        <span
          draggable={onDragStart !== undefined}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="flex min-w-0 items-center gap-2.5 [-webkit-app-region:no-drag]"
        >
          <span className="truncate">{title}</span>
          {detail !== undefined && (
            <small title={detailTitle} className="truncate text-xs font-normal text-faint">
              {detail}
            </small>
          )}
        </span>
        {onClose !== undefined && (
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
            className="ml-auto grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] hover:bg-hover hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        )}
      </header>
      <div className="min-h-0 overflow-auto px-5 pt-2 pb-5 font-mono text-[12.5px]/[1.75] text-muted">
        {children}
      </div>
    </section>
  );
}
