/**
 * What the notification sink refuses before it touches the database (D-286): the module a notice is written as is the
 * module the sink was made for, never the one that declares the kind. A transaction that fails on any use shows that
 * the refusal writes nothing, and reads nothing either.
 */
import { describe, expect, test } from 'bun:test';
import type { Transaction } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { NO_LOG } from '../../platform/events';
import { serverMetrics } from '../../platform/metrics';
import type { ModuleNotice } from '../../platform/ports/notification-sink';
import { NOW } from '../../testing/doubles';
import { notificationSink } from './sink';

/** A transaction that fails on any use: a refused notice reads nothing and writes nothing. */
const untouched = new Proxy({} as Transaction, {
  get: (_target, name): never => {
    throw new Error(`the refused notice used the transaction: ${String(name)}`);
  },
});
/** The refusal comes before the context is read; a context cannot be made without a database, so none is given. */
const noContext = undefined as never;

const notice: ModuleNotice = {
  kind: 'thing_assigned',
  recipientId: crypto.randomUUID(),
  subject: { type: 'thing', id: crypto.randomUUID() },
  params: {},
};

const sinkFor = (module: string): ReturnType<typeof notificationSink> =>
  notificationSink({
    module,
    clock: fixedClock(NOW),
    kinds: new Map([['thing_assigned', 'things']]),
    bus: {
      publish: () => Promise.resolve(),
      subscribe: () => true,
      unsubscribe: () => undefined,
      forget: () => undefined,
    },
    log: NO_LOG,
    written: serverMetrics().inboxEntries,
    pushedKinds: new Set(),
  });

const failureOf = async (call: Promise<unknown>): Promise<string | undefined> => {
  try {
    await call;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('the notification sink is the caller’s', () => {
  test('a module that does not declare a kind is refused it, naming both modules, before the database is used', async () => {
    const message = await failureOf(sinkFor('zz').notify(untouched, noContext, notice));
    expect(message).toMatch(/"zz".*"thing_assigned".*"things"/);
  });

  test('a kind no module declares is refused too', async () => {
    const message = await failureOf(
      sinkFor('things').notify(untouched, noContext, { ...notice, kind: 'unheard_of' }),
    );
    expect(message).toMatch(/"unheard_of"/);
  });

  test('the module that declares the kind is not refused', async () => {
    const message = await failureOf(sinkFor('things').notify(untouched, noContext, notice));
    expect(message).not.toMatch(/cannot write|declares the notification kind/);
  });
});
