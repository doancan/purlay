/**
 * Work a request leaves for after its answer, so how long the answer takes says nothing about what the
 * work found (D-138 §1, §6). Each piece runs at once and is not waited for by the request; a failure is
 * written down by its code, since nobody is left to tell and its words may name somebody; and
 * `settled` waits for every piece started, even one started while it waits — what a shutdown waits
 * for before the pool closes, and what a test waits for before reading the outcome.
 */
import type { Logger } from './logging';

export interface AfterAnswer {
  /** Starts `work` and returns: its caller answers without it. */
  readonly run: (work: () => Promise<void>) => void;
  /** Resolves when every piece started so far has finished, however it finished. */
  readonly settled: () => Promise<void>;
}

/** A failure's code (`23505`, `ECONNREFUSED`) or, without one, its kind; nothing it says. */
const reasonOf = (error: unknown): string => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return error instanceof Error ? error.name : typeof error;
};

export const afterAnswer = (log: Logger, purpose: string): AfterAnswer => {
  const running = new Set<Promise<void>>();
  return {
    run: (work): void => {
      // Started inside a promise, so a piece that throws before it returns one is caught like the rest.
      const piece: Promise<void> = new Promise<void>((resolve) => {
        resolve(work());
      })
        .catch((error: unknown) => {
          // Its purpose and its code alone: a driver's message and detail can quote an address back,
          // and the work was about one (ARCHITECTURE.md §10).
          log.error('work left for after an answer failed', { purpose, reason: reasonOf(error) });
        })
        .finally(() => {
          running.delete(piece);
        });
      running.add(piece);
    },
    settled: async (): Promise<void> => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
};
