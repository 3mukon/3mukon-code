import { useEffect, useState } from 'react';

// The time now, in milliseconds since the epoch, moving on every so often, so that times shown
// relative to it, such as how long ago something was read, keep up.
export function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, every);
    return () => {
      clearInterval(timer);
    };
  }, [every]);
  return now;
}
