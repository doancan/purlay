/**
 * Running something later, as a dependency: `Schedule(fn, ms)` runs `fn` after `ms` and returns the function that
 * cancels it. What waits on time (a debounce, a toast's life, a retry) takes one, so a test moves the time itself.
 * The real one is `browserSchedule`. It lives here, not with the socket it was first written for, because the
 * toast, the sidebar and the data layer use it too.
 */
export type Schedule = (fn: () => void, ms: number) => () => void;

export const browserSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return (): void => {
    clearTimeout(handle);
  };
};
