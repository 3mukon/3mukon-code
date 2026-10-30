export type Status = 'running' | 'waiting' | 'done' | 'idle';

const look: Record<Status, string> = {
  running: 'bg-run shadow-[0_0_0_3px_var(--color-run-halo)]',
  waiting: 'bg-wait',
  done: 'border border-idle',
  idle: 'bg-idle',
};

// A status as a small coloured dot, which keeps its size in a line of text too. The dot is decorative,
// so whatever shows it also states the status in words for VoiceOver.
export function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-1.5 shrink-0 rounded-full ${look[status]}`}
    />
  );
}
