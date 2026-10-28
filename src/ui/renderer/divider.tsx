import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { clampRatio, minPanelHeight, minPanelWidth } from './split';

// The box of the split a divider divides, in pixels on the page.
export interface SplitBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DividerProps {
  // A row's divider stands between parts side by side, a column's lies between stacked parts.
  direction: 'row' | 'column';
  // The first part's share of the split, between 0 and 1.
  ratio: number;
  onRatioChange: (ratio: number) => void;
  // Measures the split when the divider moves.
  bounds: () => SplitBounds;
  // The divider's name for VoiceOver.
  label: string;
  // Where the parent places the divider.
  style?: CSSProperties;
}

// The line between the two parts of a split, placed by its parent. The pointer drags it, or it takes
// focus and moves with the arrow keys along the split (Shift for larger steps), Home and End. While
// the split's space allows, each part keeps the smallest size in split.ts.
export function Divider({ direction, ratio, onRatioChange, bounds, label, style }: DividerProps) {
  const row = direction === 'row';

  const resizeTo = (next: number) => {
    const box = bounds();
    onRatioChange(
      clampRatio(next, row ? box.width : box.height, row ? minPanelWidth : minPanelHeight),
    );
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const divider = event.currentTarget;
    divider.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) => {
      const box = bounds();
      const length = row ? box.width : box.height;
      const offset = row ? moved.clientX - box.left : moved.clientY - box.top;
      if (length > 0) resizeTo(offset / length);
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
    const [back, forward] = row ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const targets: Record<string, number> = {
      [back]: ratio - step,
      [forward]: ratio + step,
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
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={style}
      className={`absolute z-10 bg-line after:absolute after:content-[''] ${row ? 'w-px cursor-col-resize after:inset-y-0 after:-inset-x-1' : 'h-px cursor-row-resize after:-inset-y-1 after:inset-x-0'}`}
    />
  );
}
