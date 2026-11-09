/**
 * What a worker's visit and a fact's consumer are handed to tell the rest of the build something (`MODULES.md` §4, D-283 §2, D-286):
 * the module's `notify` and `publishFact`, bound to its transaction, to the workspace the framework is acting for and to the
 * module they speak as. A request has these on `ModuleRouteDependencies`, with a person to act as; here nobody is acting, so the
 * workspace is the `WorkspaceScope` the framework handed out (`workspace-turn.ts`), a notice has no actor, and a fact published
 * from a delivery says which fact it is a consequence of, which bounds the chain (`FACT_CHAIN_DEPTH_MAX`).
 *
 * The notices a seam writes are announced (counted, pushed, told to the person's tabs) only once the transaction has committed:
 * `inWorkspace` does it for a worker, the delivery for a consumer.
 */
import type { Static } from '@sinclair/typebox';
import type { Executor, Transaction } from '@purlay/db';
import type { FactDeclaration } from '@purlay/types';
import { publishFact } from '../outbox';
import { atomicallyOn } from '../transactions';
import { assertTurn } from '../workspace-turn';
import type { SharedFactContext } from './fact-publisher';
import type { ModuleNotice, NotificationSink, WrittenNotice } from './notification-sink';
import type { WorkspaceScope } from './record-ref';

export interface WorkspaceSeam {
  /** The module's notice to a member of the workspace: its own declared kind, no actor; `undefined` when nobody is owed it. */
  readonly notify: (notice: ModuleNotice) => Promise<WrittenNotice | undefined>;
  /** A fact of the module's own (`publishes`), written in this transaction; refused as any publish is, and past the chain's depth. */
  readonly publishFact: <Fact extends FactDeclaration>(
    fact: Fact,
    payload: Static<Fact['schema']>,
  ) => Promise<void>;
}

/** A seam over one transaction, and the notices it wrote, for whoever commits to announce. */
interface BoundSeam {
  readonly seam: WorkspaceSeam;
  readonly written: () => readonly WrittenNotice[];
}

export interface ModuleSeams {
  /** `causedBy` is the fact whose delivery this is, when one is. */
  readonly bind: (transaction: Transaction, turn: WorkspaceScope, causedBy?: string) => BoundSeam;
  readonly announce: NotificationSink['announce'];
}

export const moduleSeams = (
  producer: string,
  sink: NotificationSink,
  shared: SharedFactContext,
): ModuleSeams => ({
  announce: sink.announce,
  bind: (transaction, turn, causedBy): BoundSeam => {
    assertTurn(turn);
    const written: WrittenNotice[] = [];
    return {
      written: (): readonly WrittenNotice[] => written,
      seam: {
        notify: async (notice): Promise<WrittenNotice | undefined> => {
          const told = await sink.notifyIn(transaction, turn, notice);
          if (told !== undefined) written.push(told);
          return told;
        },
        publishFact: async (fact, payload): Promise<void> => {
          await publishFact(
            transaction,
            {
              ...shared,
              workspaceId: turn.workspaceId,
              producer,
              ...(causedBy === undefined ? {} : { causedBy }),
            },
            fact,
            payload,
          );
        },
      },
    };
  },
});

const refuse = (): never => {
  throw new Error('this process has no seams: notify and publishFact are not wired');
};

/** The seam of a delivery or a visit in a process with none wired (a test of one module's pieces): every call is refused, loudly. */
export const noSeam: WorkspaceSeam = { notify: refuse, publishFact: refuse };

export const noSeams: ModuleSeams = {
  announce: () => Promise.resolve(),
  bind: () => ({ written: () => [], seam: noSeam }),
};

/**
 * Runs `work` in one transaction of `database` for the workspace of `turn`, with the module's seam over it, and announces the
 * notices it wrote once that transaction has committed (and not at all if it did not).
 */
export const inWorkspace = async <T>(
  seams: ModuleSeams,
  database: Executor,
  turn: WorkspaceScope,
  work: (transaction: Transaction, seam: WorkspaceSeam) => Promise<T>,
): Promise<T> => {
  let told: readonly WrittenNotice[] = [];
  const result = await atomicallyOn(database)(async (transaction) => {
    const bound = seams.bind(transaction, turn);
    const done = await work(transaction, bound.seam);
    told = bound.written();
    return done;
  });
  await seams.announce(told);
  return result;
};
