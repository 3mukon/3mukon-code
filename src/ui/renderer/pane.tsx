import type { PointerEvent, ReactNode, Ref } from 'react';
import { X } from './icons';
import { StatusDot, type Status } from './status-dot';

interface PaneProps {
  title: string;
  // Shown after the title in a quieter style, such as the provider's name or a folder's name. It takes
  // only the room the title leaves, so that where both do not fit it gives way first, and the title
  // shortens only once the detail is gone.
  detail?: string;
  // The detail in full, as its tooltip, such as a path.
  detailTitle?: string;
  status?: Status;
  // The status in words, for VoiceOver.
  statusLabel?: string;
  // The pane holds unsaved changes: its close button shows a dot until the pointer or the keyboard
  // reaches it, as the close buttons of macOS's documents do, and VoiceOver hears the label after the
  // title.
  unsaved?: boolean;
  unsavedLabel?: string;
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
  // Shown at the start of the header, before the status and title, such as what lies beside the
  // window buttons while the header clears them.
  start?: ReactNode;
  // Shown at the end of the header, before the close button, such as a choice of how the pane shows
  // what it holds.
  actions?: ReactNode;
  // A press on the pane's title and detail, by which its parent moves it with the pointer.
  onHandlePointerDown?: (event: PointerEvent<HTMLElement>) => void;
  // The pane's own element, for a parent that moves focus to it.
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
}

// One pane of the main area: a header with the status, title, detail and close button, as tall as the
// title bar, above a body that its content lays out and scrolls itself. The pane takes focus from the keyboard as a whole, and marks
// itself as the current one while it has focus. Its title and detail are its handle, which its parent
// may move it by, and whose text does not select; in the title bar, they and the button still take
// clicks.
export function Pane({
  title,
  detail,
  detailTitle,
  status,
  statusLabel,
  unsaved = false,
  unsavedLabel,
  focused,
  onFocus,
  onClose,
  closeLabel,
  inTitleBar = false,
  clearsWindowButtons = false,
  start,
  actions,
  onHandlePointerDown,
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
        {start}
        {status !== undefined && <StatusDot status={status} />}
        {statusLabel !== undefined && <span className="sr-only">{statusLabel}</span>}
        <span
          onPointerDown={onHandlePointerDown}
          className="flex min-w-0 touch-none items-center gap-2.5 select-none [-webkit-app-region:no-drag]"
        >
          <span className="truncate">{title}</span>
          {unsaved && unsavedLabel !== undefined && <span className="sr-only">{unsavedLabel}</span>}
          {detail !== undefined && (
            <small title={detailTitle} className="flex-1 truncate text-xs font-normal text-faint">
              {detail}
            </small>
          )}
        </span>
        {actions !== undefined && (
          <div className="ml-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
            {actions}
          </div>
        )}
        {onClose !== undefined && (
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
            className={`group/close ${actions === undefined ? 'ml-auto' : ''} grid size-5 shrink-0 place-items-center rounded-md text-faint [-webkit-app-region:no-drag] hover:bg-hover hover:text-ink`}
          >
            {unsaved ? (
              <>
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-muted group-hover/close:hidden group-focus-visible/close:hidden"
                />
                <X className="hidden size-3.5 group-hover/close:block group-focus-visible/close:block" />
              </>
            ) : (
              <X className="size-3.5" />
            )}
          </button>
        )}
      </header>
      <div className="grid min-h-0 min-w-0">{children}</div>
    </section>
  );
}
