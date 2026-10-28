import type { Logger } from '../../platform/logging';

/** One flight per process; shutdown awaits it before closing the database. */
export const timedDeliveryLoop = (
  run: () => Promise<unknown>,
  later: (callback: () => void, milliseconds: number) => () => void,
  log: Logger,
): { readonly start: () => void; readonly stop: () => Promise<void> } => {
  let stopped = true;
  let cancel: (() => void) | undefined;
  let flight: Promise<void> | undefined;
  const tick = (): void => {
    flight = (async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        log.error('timed delivery failed; retrying next tick', { err: error });
      } finally {
        if (!stopped) cancel = later(tick, 15_000);
      }
    })();
  };
  return {
    start: (): void => {
      if (stopped) {
        stopped = false;
        tick();
      }
    },
    stop: async (): Promise<void> => {
      stopped = true;
      cancel?.();
      await flight;
    },
  };
};
