import { StatusDot } from './status-dot';

interface WaitingIndicatorProps {
  // How many sessions wait on the user.
  count: number;
  // What activating it does, in words, for VoiceOver and the tooltip.
  label: string;
  onActivate: () => void;
}

// The title bar's count of sessions waiting on the user, which jumps to one of them. It renders
// nothing while no session is waiting.
export function WaitingIndicator({ count, label, onActivate }: WaitingIndicatorProps) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onActivate}
      className="flex items-center gap-1.5 rounded-md px-1.5 text-xs text-wait [-webkit-app-region:no-drag] hover:bg-hover"
    >
      <StatusDot status="waiting" />
      <span aria-hidden="true">{count}</span>
    </button>
  );
}
