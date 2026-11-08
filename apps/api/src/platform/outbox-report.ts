/**
 * What the outbox holds, read for the operator (`MODULES.md` §4, D-288 §9): for each consumer the rows waiting, how long the
 * oldest has waited and the rows that are dead. Read when asked, by the metrics page and the server's overview, and not kept: the
 * table is the record, and every node reports the same cluster-wide values (Prometheus takes the `max`).
 *
 * A consumer is a module id, so the series are the modules that consume a fact: a closed set from the manifests, made at zero.
 */
import type { Executor } from '@purlay/db';
import type { MetricFamily } from './exposition';
import type { Logger } from './logging';
import { OUTBOX_DEAD_KEPT_DAYS } from './outbox-sweep';

/** A consumer whose oldest waiting fact is older than this, or any dead fact, is a problem the overview names. */
export const OUTBOX_STALE_AFTER_SECONDS = 900;
const READ_TIMEOUT_MS = 2_000;

export interface OutboxReading {
  readonly consumer: string;
  readonly pending: number;
  /** Whole seconds since the oldest pending fact was published; 0 where none waits. */
  readonly oldestPendingSeconds: number;
  readonly dead: number;
}

/** The consumers' rows by state, for the ones asked about and no other. */
export const readOutbox = async (
  database: Executor,
  consumers: readonly string[],
  now: Date,
): Promise<readonly OutboxReading[]> => {
  if (consumers.length === 0) return [];
  const [waiting, dead] = await Promise.all([
    database
      .selectFrom('outbox')
      .select((eb) => [
        'consumer',
        eb.fn.countAll<string>().as('rows'),
        eb.fn.min('created_at').as('oldest'),
      ])
      .where('state', '=', 'pending')
      .where('consumer', 'in', consumers)
      .groupBy('consumer')
      .execute(),
    database
      .selectFrom('outbox')
      .select((eb) => ['consumer', eb.fn.countAll<string>().as('rows')])
      .where('state', '=', 'dead')
      .where('consumer', 'in', consumers)
      .groupBy('consumer')
      .execute(),
  ]);
  return consumers.map((consumer) => {
    const pending = waiting.find((row) => row.consumer === consumer);
    return {
      consumer,
      pending: Number(pending?.rows ?? 0),
      oldestPendingSeconds:
        pending === undefined
          ? 0
          : Math.max(0, Math.floor((now.getTime() - pending.oldest.getTime()) / 1000)),
      dead: Number(dead.find((row) => row.consumer === consumer)?.rows ?? 0),
    };
  });
};

/** The overview's two numbers over every consumer: the facts given up on, and how long the longest-waiting has waited. */
export const outboxOverview = (
  readings: readonly OutboxReading[],
): { readonly deadFacts: number; readonly oldestPendingSeconds: number } => ({
  deadFacts: readings.reduce((total, one) => total + one.dead, 0),
  oldestPendingSeconds: Math.max(0, ...readings.map((one) => one.oldestPendingSeconds)),
});

/** The three gauges, one series for each consumer. */
export const outboxFamilies = (readings: readonly OutboxReading[]): readonly MetricFamily[] => [
  {
    name: 'purlay_outbox_pending',
    help: 'Facts waiting to be delivered to a module, by the module that consumes them; the same on every node of a cluster.',
    type: 'gauge',
    samples: readings.map((r) => ({
      suffix: '',
      labels: { module: r.consumer },
      value: r.pending,
    })),
  },
  {
    name: 'purlay_outbox_oldest_age_seconds',
    help: 'Seconds the oldest fact waiting for a module has waited, 0 where none waits.',
    type: 'gauge',
    samples: readings.map((r) => ({
      suffix: '',
      labels: { module: r.consumer },
      value: r.oldestPendingSeconds,
    })),
  },
  {
    name: 'purlay_outbox_dead',
    help: `Facts given up on after their tries, kept ${String(OUTBOX_DEAD_KEPT_DAYS)} days to be looked at, by the module that was to consume them.`,
    type: 'gauge',
    samples: readings.map((r) => ({ suffix: '', labels: { module: r.consumer }, value: r.dead })),
  },
];

/** Reads the outbox for each scrape, bounded; a read that fails is said once and leaves the gauges out, never at zero. */
export const outboxMetrics = (dependencies: {
  readonly read: () => Promise<readonly OutboxReading[]>;
  readonly log: Logger;
  readonly timeoutMs?: number;
}): (() => Promise<readonly MetricFamily[]>) => {
  const { read, log, timeoutMs = READ_TIMEOUT_MS } = dependencies;
  let failing = false;
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        resolve('late');
      }, timeoutMs);
    });
    try {
      const readings = await Promise.race([read(), late]);
      if (readings === 'late') throw new Error(`no answer within ${String(timeoutMs)} ms`);
      failing = false;
      return outboxFamilies(readings);
    } catch (error) {
      if (!failing) log.warn('the outbox could not be read for metrics', { err: error });
      failing = true;
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
};
