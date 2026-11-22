import { useEffect, useState } from 'react';
import type { PreviewFailureReason } from '../../sessions/shared/automation';
import type { MessageImage } from '../../sessions/shared/events';
import type { ComputerBridge } from '../shared/computer';

// How often a shown preview asks for a new frame; main takes one each 750 ms at most.
const PREVIEW_EVERY_MS = 1_000;

// What a computer target's panel shows of it: the last frame main gave, with when it was taken, and
// why the latest could not be taken, if it could not; nothing yet before main first answers.
export interface ComputerPreview {
  answered: boolean;
  frame: { image: MessageImage; capturedAt: number } | null;
  unavailable: PreviewFailureReason | null;
}

const NOT_YET: ComputerPreview = { answered: false, frame: null, unavailable: null };

// A window's preview while its panel shows it: asked for at once, then once a second, while the window
// is visible, never more often than main answers; a busy answer keeps the last frame, and a panel main
// has not yet heard of asks again. Showing it grants nothing and hiding it stops nothing.
export function useComputerPreview(
  port: Pick<ComputerBridge, 'preview'>,
  owner: string,
  presentation: string,
  target: string,
): ComputerPreview {
  // Each preview is kept with the window it shows, so that another window's starts from nothing.
  const shown = `${owner}\n${presentation}\n${target}`;
  const [kept, setKept] = useState<{ shown: string; preview: ComputerPreview } | null>(null);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setPreview = (next: (before: ComputerPreview) => ComputerPreview) => {
      setKept((before) => ({
        shown,
        preview: next(before?.shown === shown ? before.preview : NOT_YET),
      }));
    };
    const later = () => {
      timer = setTimeout(ask, PREVIEW_EVERY_MS);
    };
    const ask = () => {
      if (document.hidden) {
        later();
        return;
      }
      port.preview(owner, presentation, target).then(
        (outcome) => {
          if (!current) return;
          if (outcome.status === 'verified') {
            const value = outcome.value;
            setPreview((before) =>
              value.status === 'frame'
                ? {
                    answered: true,
                    frame: { image: value.frame.image, capturedAt: value.frame.capturedAt },
                    unavailable: null,
                  }
                : { answered: true, frame: before.frame, unavailable: value.reason },
            );
          } else if (
            outcome.status === 'refused' &&
            outcome.code !== 'busy' &&
            outcome.code !== 'not-found'
          ) {
            setPreview((before) => ({
              answered: true,
              frame: before.frame,
              unavailable: 'target-state-unsupported',
            }));
          }
          later();
        },
        (error: unknown) => {
          console.error('The preview could not be read:', error);
          if (current) later();
        },
      );
    };
    ask();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [port, owner, presentation, target, shown]);
  return kept?.shown === shown ? kept.preview : NOT_YET;
}
