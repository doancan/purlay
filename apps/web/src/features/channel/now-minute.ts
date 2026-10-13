/**
 * The current minute, ticking on the minute: a row's "12m ago" is right without a timer per row.
 * The feed and the thread panel each keep one, through the same ports, so a test moves both.
 */
import { useEffect, useState } from 'react';
import type { FeedPorts } from './feed-ports';

const MINUTE_MS = 60_000;

const floorMinute = (date: Date): number => Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;

export const useNowMinute = (ports: FeedPorts): number => {
  const [now, setNow] = useState(() => floorMinute(ports.clock.now()));
  useEffect(() => {
    let cancel = (): void => undefined;
    const tick = (): void => {
      setNow(floorMinute(ports.clock.now()));
      cancel = ports.schedule(tick, MINUTE_MS);
    };
    cancel = ports.schedule(tick, MINUTE_MS - (ports.clock.now().getTime() % MINUTE_MS));
    return (): void => {
      cancel();
    };
  }, [ports]);
  return now;
};
