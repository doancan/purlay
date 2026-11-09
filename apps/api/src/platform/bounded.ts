/**
 * The bound of a queue of things that wait in memory: past it the oldest let go, not the newest. What has
 * waited longest is the nearest to being worth nothing (a push is kept by a device for a day at most), and
 * what has just come in is what a person is waiting for; refusing the new to keep the old is the wrong way
 * round for a notice. A map keeps its keys in the order they were put in, which is the order they came.
 */

/** Lets go of the oldest entries of `entries` until at most `max` are left, and says which went. */
export const dropOldest = <K, V>(entries: Map<K, V>, max: number): K[] => {
  const gone: K[] = [];
  for (const key of entries.keys()) {
    if (entries.size <= max) break;
    entries.delete(key);
    gone.push(key);
  }
  return gone;
};

/** The same for a line, oldest first: lets go of its front until at most `max` are left, and says how many. */
export const dropOldestOf = (line: unknown[], max: number): number => {
  const excess = Math.max(line.length - max, 0);
  if (excess > 0) line.splice(0, excess);
  return excess;
};

/**
 * Puts `incoming` behind what is already in `line` and keeps at most `max`, the newest: what was waiting goes
 * first, and a batch larger than the line keeps its own newest. Says how many went. Pushed one by one, not
 * spread into a call, so a batch of any size is safe.
 */
export const admit = <T>(line: T[], incoming: readonly T[], max: number): number => {
  const kept =
    incoming.length > max ? incoming.slice(Math.max(incoming.length - max, 0)) : incoming;
  for (const item of kept) line.push(item);
  return incoming.length - kept.length + dropOldestOf(line, max);
};
