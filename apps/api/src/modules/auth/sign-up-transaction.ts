/**
 * The transaction the sign-in library makes an account in, made reachable by the one hook that must
 * write inside it.
 *
 * Better Auth makes an account — and, for a first GitHub sign-in or a link's spend, its other rows — in
 * one transaction it opens itself (`db.transaction().execute(…)` of the Kysely it was given) and hands
 * its hooks no handle to. The invitation passport has to be spent *in that transaction* (D-179 §5, R51):
 * spent by a sign-up that then fails to insert the account, it would be lost with nothing made; unspent
 * by one that succeeded, it would open a second account. So the database handed to the library is this
 * one, which behaves as the original in every respect and, around each transaction, remembers it for
 * the duration of the callback (`AsyncLocalStorage`), where `heldTransaction` reads it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Executor, Transaction } from '@purlay/db';

const held = new AsyncLocalStorage<Transaction>();

/** The library's transaction this code is running inside, if it is inside one. */
export const heldTransaction = (): Transaction | undefined => held.getStore();

/** What `Reflect.get` found on `target`, a method bound to it: a proxy's `this` is the proxy, not Kysely. */
const boundTo = (target: object, property: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
};

/** `database`, with every transaction it opens remembered for the length of its callback. */
export const rememberingTransactions = (database: Executor): Executor =>
  new Proxy(database, {
    get: (target, property): unknown => {
      if (property !== 'transaction') return boundTo(target, property);
      return (): unknown =>
        new Proxy(target.transaction(), {
          get: (builder, member): unknown => {
            if (member !== 'execute') return boundTo(builder, member);
            return async (body: (transaction: Transaction) => Promise<unknown>): Promise<unknown> =>
              await builder.execute(
                async (transaction) => await held.run(transaction, () => body(transaction)),
              );
          },
        });
    },
  });
