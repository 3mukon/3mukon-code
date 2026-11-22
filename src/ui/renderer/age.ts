import { useEffect, useState } from 'react';

// How old something is, in the unit a preview names it by: seconds under a minute, then minutes
// under an hour, then hours. Each module words it in its own catalog.
export function ageOf(milliseconds: number): {
  unit: 'seconds' | 'minutes' | 'hours';
  count: number;
} {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return { unit: 'seconds', count: seconds };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  return { unit: 'hours', count: Math.round(minutes / 60) };
}

// The time, to the second, while something's age shows: it ticks only while asked to.
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [ticking]);
  return now;
}
