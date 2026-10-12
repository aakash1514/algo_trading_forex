'use client';

import { useEffect, useState } from 'react';

// The current time, re-read every `intervalMs`, so price ages and STALE badges update without new ticks.
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
