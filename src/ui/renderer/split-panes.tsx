import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { clampSplit } from './split';

interface SplitPanesProps {
  first: ReactNode;
  // Without a second pane, the first one takes the whole width and there is no divider.
  second?: ReactNode;
  // The first pane's share of the width, between 0 and 1.
  split: number;
  onSplitChange: (split: number) => void;
  // The divider's name for VoiceOver.
  resizeLabel: string;
}

// One pane, or two side by side with a divider between them. The divider is dragged with the pointer,
// or focused and moved with the arrow keys (Shift for larger steps), Home and End.
export function SplitPanes({ first, second, split, onSplitChange, resizeLabel }: SplitPanesProps) {
  const container = useRef<HTMLDivElement>(null);
  if (second === undefined) return <div className="grid min-h-0 min-w-0 flex-1">{first}</div>;

  const resizeTo = (next: number) => {
    const width = container.current?.getBoundingClientRect().width ?? 0;
    onSplitChange(clampSplit(next, width));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const divider = event.currentTarget;
    divider.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) => {
      const rect = container.current?.getBoundingClientRect();
      if (rect && rect.width > 0) resizeTo((moved.clientX - rect.left) / rect.width);
    };
    const end = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', end);
      divider.removeEventListener('pointercancel', end);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const targets: Record<string, number> = {
      ArrowLeft: split - step,
      ArrowRight: split + step,
      Home: 0,
      End: 1,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resizeTo(next);
  };

  return (
    <div
      ref={container}
      className="grid min-h-0 min-w-0 flex-1"
      style={{
        gridTemplateColumns: `minmax(0, ${String(split)}fr) 1px minmax(0, ${String(1 - split)}fr)`,
      }}
    >
      {first}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="relative cursor-col-resize bg-line after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']"
      />
      {second}
    </div>
  );
}
