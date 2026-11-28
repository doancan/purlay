/**
 * Starts reading something ahead of the click that will want it, and lets a failed read go: the click asks again
 * and says what went wrong then, so an early failure is not an unhandled rejection in the console.
 */
export const prefetch = (load: () => Promise<unknown>): void => {
  load().catch(() => undefined);
};
