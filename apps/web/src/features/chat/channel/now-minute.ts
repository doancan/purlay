/**
 * The current minute, ticking on the minute: a row's "12m ago" is right without a timer per row.
 * The feed and the thread panel each keep one, through the same ports, so a test moves both.
 */
import { useEffect, useState } from 'react';
import { MINUTE_MS } from '../../../lib/time';
import type { FeedPorts } from './feed-ports';

const floorMinute = (date: Date): number => Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;

export const useNowMinute = (ports: FeedPorts): number => {
  const [now, setNow] = useState(() => floorMinute(ports.clock.now()));
  useEffect(() => {
    // Assigned before anything can call it: the first schedule is made below, and each tick makes the next.
    let cancel: () => void;
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

/** The longest a message shows its age in minutes: after an hour it shows a clock time or a day instead. */
const MINUTES_SHOWN_FOR = 60 * MINUTE_MS;
/**
 * Every time zone's midnight, and every half and three-quarter hour offset, falls on a quarter hour: a label that
 * is a clock time or a day cannot change between two quarters.
 */
const QUARTER_MS = 15 * MINUTE_MS;

/**
 * The time a row is drawn "as of". A message under an hour old says "12m ago", so it follows the minute; an older
 * one says a clock time or a day, which a quarter hour cannot change, so it follows the quarter. A row compares
 * this by value, so most of the feed is left alone each minute instead of being drawn again for nothing.
 */
export const rowStamp = (createdAt: string, nowMinute: number): number =>
  nowMinute - Date.parse(createdAt) < MINUTES_SHOWN_FOR + MINUTE_MS
    ? nowMinute
    : Math.floor(nowMinute / QUARTER_MS) * QUARTER_MS;

/** The day labels of a feed change only when a day does: the same quarter-hour stamp, for the whole feed. */
export const dayStamp = (nowMinute: number): number =>
  Math.floor(nowMinute / QUARTER_MS) * QUARTER_MS;
