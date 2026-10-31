import type { SessionSummary } from '../../sessions/shared/sessions';
import { waitingSessions } from '../shared/waiting';

// The parts of Electron's Dock the app uses, so that tests can stand in for them.
export interface Dock {
  setBadge(text: string): void;
  bounce(type: 'informational'): number;
}

// Shows how many sessions wait on the user as the Dock icon's badge, and bounces the icon once when
// one more starts waiting while no window of the app has focus, as macOS apps ask for attention.
export function dockAttention(
  dock: Dock,
  focused: () => boolean,
): (sessions: readonly SessionSummary[]) => void {
  let shown = 0;
  return (sessions) => {
    const { count } = waitingSessions(sessions);
    if (count === shown) return;
    dock.setBadge(count === 0 ? '' : String(count));
    if (count > shown && !focused()) dock.bounce('informational');
    shown = count;
  };
}
