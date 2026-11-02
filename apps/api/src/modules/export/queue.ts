/**
 * The process's exports, one at a time, in the order asked — an owner's of a workspace (D-140) and a
 * person's of their own data (D-241) in the one line: each holds a snapshot transaction and a scratch
 * directory while it runs, and the chat comes first. `settled` is what shutdown may wait on.
 */
import { runPersonalExport } from './personal-requests';
import { runExport, type RunDependencies } from './requests';

export interface ExportQueue {
  /** Starts making a workspace's export once its request has committed. */
  readonly start: (exportId: string) => void;
  /** Starts making a person's export once its request has committed. */
  readonly startPersonal: (exportId: string) => void;
  readonly settled: () => Promise<void>;
}

export const exportQueue = (dependencies: RunDependencies): ExportQueue => {
  let tail: Promise<void> = Promise.resolve();
  const after = (run: () => Promise<void>): void => {
    tail = tail.then(run);
  };
  return {
    start: (exportId): void => {
      after(async () => {
        await runExport(dependencies, exportId);
      });
    },
    startPersonal: (exportId): void => {
      after(async () => {
        await runPersonalExport(dependencies, exportId);
      });
    },
    settled: async (): Promise<void> => {
      await tail;
    },
  };
};
