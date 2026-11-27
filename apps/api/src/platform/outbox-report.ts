/**
 * What the outbox holds, read for the operator (`MODULES.md` §4, D-288 §9, D-353): for each consumer the rows waiting, how long the
 * oldest a node can deliver has waited, the rows held on purpose and why, and the rows that are dead. Read when asked, by the metrics
 * page and the server's overview, and not kept: the table is the record.
 *
 * **Held is not late** (D-353). A row of a workspace that is not granted its consumer, of a consumer this node does not run or has
 * stopped, or of a shape newer than this node reads, waits on purpose: nothing is wrong until someone grants, starts or upgrades. Such
 * a row is counted in `purlay_outbox_held{module,reason}` and is not the age the alerts page on, which is of the rows this node would
 * claim (a row waiting out its backoff included: it is late, not held). Each node says what it can deliver, so a cluster's age is the
 * `max` over its nodes: the node that runs the consumer. A row past its expiry is neither; `sweep:outbox` counts it (D-353).
 *
 * A consumer is a module id, so the series are the modules that consume a fact: a closed set from the manifests, made at zero.
 */
import { sql, type Executor } from '@purlay/db';
import type { MetricFamily } from './exposition';
import { readGrants } from './grants';
import type { Logger } from './logging';
import type { EntitlementPolicy } from './module-kit/entitlement';
import type { Handled } from './outbox-drain';
import { OUTBOX_DEAD_KEPT_DAYS } from './outbox-sweep';

/** A consumer whose oldest waiting fact is older than this, or any dead fact, is a problem the overview names. */
export const OUTBOX_STALE_AFTER_SECONDS = 900;
const READ_TIMEOUT_MS = 2_000;

/** Why a pending row waits on purpose: its workspace is not granted the consumer, this node does not run it, or it is of a newer shape. */
export const OUTBOX_HOLDS = ['not_granted', 'not_run', 'newer_shape'] as const;
export type OutboxHold = (typeof OUTBOX_HOLDS)[number];

/** What a node knows of the outbox's consumers, which a pending row is judged by: held on purpose, or due to be delivered. */
export interface OutboxView {
  /** The modules the build carries that consume a fact, whether this process runs them or not: a series each. */
  readonly consumers: readonly string[];
  /** Each (consumer, fact type) the build's manifests consume: the series of the expired count, made at zero. */
  readonly consumed: readonly OutboxPair[];
  /** What this node can deliver now (`Composition.outboxHandles`): of the modules it runs and has not stopped, each type and newest shape. */
  readonly handles: () => readonly Handled[];
  /** The modules a workspace may use as this node judges them, which is what its claim asks (`Composition.effectiveModules`). */
  readonly effective: EntitlementPolicy['effective'];
  /** The modules a workspace is granted over the whole build, the same on every node (`Composition.grantedModules`). */
  readonly granted: EntitlementPolicy['effective'];
}

/** A consumer and a fact type it consumes. */
export interface OutboxPair {
  readonly consumer: string;
  readonly type: string;
}

/** How many facts of a type `sweep:outbox` gave up on at their expiry for a consumer, ever (`outbox_expired`, D-353). */
export interface OutboxExpiry extends OutboxPair {
  readonly expired: number;
}

/** What one scrape reads: each consumer's rows, and the counts of what expired. */
export interface OutboxReport {
  readonly readings: readonly OutboxReading[];
  readonly expired: readonly OutboxExpiry[];
}

export interface OutboxReading {
  readonly consumer: string;
  /** Every pending row, held or not: the backlog's depth. */
  readonly pending: number;
  /** Whole seconds since the oldest pending fact this node would claim was published; 0 where none waits. */
  readonly oldestPendingSeconds: number;
  /** The pending rows that wait on purpose, by why. */
  readonly held: Readonly<Record<OutboxHold, number>>;
  readonly dead: number;
}

const noneHeld = (): Record<OutboxHold, number> => ({ not_granted: 0, not_run: 0, newer_shape: 0 });

const secondsSince = (now: Date, first: Date | null | undefined): number =>
  first === null || first === undefined
    ? 0
    : Math.max(0, Math.floor((now.getTime() - first.getTime()) / 1000));

/**
 * The workspaces that have a pending row for the consumer, found by walking `idx_outbox_pending_by_workspace` from one to the next
 * (as the claim does), so the cost is a probe for each workspace and not a read of every row.
 */
const workspacesWaitingFor = async (database: Executor, consumer: string): Promise<string[]> => {
  const { rows } = await sql<{ workspace_id: string | null }>`
    with recursive spaces(workspace_id) as (
      (select workspace_id from outbox where consumer = ${consumer} and state = 'pending' order by workspace_id limit 1)
      union all
      select (select o.workspace_id from outbox o where o.consumer = ${consumer} and o.state = 'pending'
                and o.workspace_id > spaces.workspace_id order by o.workspace_id limit 1)
      from spaces where spaces.workspace_id is not null
    )
    select workspace_id from spaces where workspace_id is not null`.execute(database);
  return rows.flatMap((row) => (row.workspace_id === null ? [] : [row.workspace_id]));
};

/** One consumer's pending rows, as this node sees them. */
const readPending = async (
  database: Executor,
  consumer: string,
  view: OutboxView,
  now: Date,
): Promise<Pick<OutboxReading, 'pending' | 'oldestPendingSeconds' | 'held'>> => {
  const handles = view.handles().filter((handle) => handle.consumer === consumer);
  const held = noneHeld();
  if (handles.length === 0) {
    const row = await database
      .selectFrom('outbox')
      .select((eb) => [
        eb.fn.countAll<string>().as('pending'),
        sql<string>`count(*) filter (where expires_at > ${now})`.as('live'),
      ])
      .where('state', '=', 'pending')
      .where('consumer', '=', consumer)
      .executeTakeFirstOrThrow();
    held.not_run = Number(row.live);
    return { pending: Number(row.pending), oldestPendingSeconds: 0, held };
  }
  const workspaces = await workspacesWaitingFor(database, consumer);
  const grants = await readGrants(database, workspaces);
  const barred = workspaces.filter(
    (id) => !view.effective(grants.get(id) ?? [], now).has(consumer),
  );
  const known = sql.join(
    handles.map((handle) => sql`(type = ${handle.type} and shape <= ${handle.shape})`),
    sql` or `,
  );
  const due = sql`expires_at > ${now} and workspace_id <> all(${barred}::uuid[])`;
  const [counts, oldest] = await Promise.all([
    // One pass over the consumer's pending rows: the same rows the depth counts, so it grows with the backlog as that does.
    sql<{ pending: string; not_granted: string; newer_shape: string }>`
      select count(*) as pending,
        count(*) filter (where expires_at > ${now} and workspace_id = any(${barred}::uuid[])) as not_granted,
        count(*) filter (where ${due} and not (${known})) as newer_shape
      from outbox where consumer = ${consumer} and state = 'pending'`.execute(database),
    // The first entry of `idx_outbox_pending_age` this node would claim: held rows before it are walked past, not a minimum of all.
    sql<{ created_at: Date }>`
      select created_at from outbox where consumer = ${consumer} and state = 'pending' and ${due} and (${known})
      order by created_at limit 1`.execute(database),
  ]);
  const [row] = counts.rows;
  held.not_granted = Number(row?.not_granted ?? 0);
  held.newer_shape = Number(row?.newer_shape ?? 0);
  return {
    pending: Number(row?.pending ?? 0),
    oldestPendingSeconds: secondsSince(now, oldest.rows[0]?.created_at),
    held,
  };
};

/** The consumers' rows by state, for the consumers of the view and no other. */
export const readOutbox = async (
  database: Executor,
  view: OutboxView,
  now: Date,
): Promise<readonly OutboxReading[]> => {
  const { consumers } = view;
  if (consumers.length === 0) return [];
  const [pending, dead] = await Promise.all([
    Promise.all(
      consumers.map(async (consumer) => await readPending(database, consumer, view, now)),
    ),
    database
      .selectFrom('outbox')
      .select((eb) => ['consumer', eb.fn.countAll<string>().as('rows')])
      .where('state', '=', 'dead')
      .where('consumer', 'in', consumers)
      .groupBy('consumer')
      .execute(),
  ]);
  return consumers.map((consumer, at) => ({
    consumer,
    pending: pending[at]?.pending ?? 0,
    oldestPendingSeconds: pending[at]?.oldestPendingSeconds ?? 0,
    held: pending[at]?.held ?? noneHeld(),
    dead: Number(dead.find((row) => row.consumer === consumer)?.rows ?? 0),
  }));
};

/**
 * The counts of `outbox_expired`, with a zero for each pair the build consumes that has none, so a counter's first increase is seen
 * (`increase` of a series that starts at one is nothing). A pair the table has and the build no longer consumes is kept: it happened.
 */
export const readExpired = async (
  database: Executor,
  consumed: readonly OutboxPair[],
): Promise<readonly OutboxExpiry[]> => {
  const rows = await database
    .selectFrom('outbox_expired')
    .select(['consumer', 'type', 'expired'])
    .orderBy('consumer')
    .orderBy('type')
    .execute();
  const counted: OutboxExpiry[] = rows.map((row) => ({
    consumer: row.consumer,
    type: row.type,
    expired: Number(row.expired),
  }));
  const unseen = consumed.filter(
    (pair) => !counted.some((row) => row.consumer === pair.consumer && row.type === pair.type),
  );
  return [...counted, ...unseen.map((pair) => ({ ...pair, expired: 0 }))];
};

/** Both reads of a scrape; a build that consumes no fact has no series and reads nothing. */
export const readOutboxReport = async (
  database: Executor,
  view: OutboxView,
  now: Date,
): Promise<OutboxReport> => {
  if (view.consumers.length === 0) return { readings: [], expired: [] };
  const [readings, expired] = await Promise.all([
    readOutbox(database, view, now),
    readExpired(database, view.consumed),
  ]);
  return { readings, expired };
};

/** The overview's two numbers over every consumer: the facts given up on, and how long the longest-waiting has waited. */
export const outboxOverview = (
  readings: readonly OutboxReading[],
): { readonly deadFacts: number; readonly oldestPendingSeconds: number } => ({
  deadFacts: readings.reduce((total, one) => total + one.dead, 0),
  oldestPendingSeconds: Math.max(0, ...readings.map((one) => one.oldestPendingSeconds)),
});

/** The four gauges, one series for each consumer (and each reason, for what is held), and the counter of what expired. */
export const outboxFamilies = ({ readings, expired }: OutboxReport): readonly MetricFamily[] => [
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
    help: 'Seconds the oldest fact this node would deliver to a module has waited, 0 where none waits; a fact held on purpose is not counted.',
    type: 'gauge',
    samples: readings.map((r) => ({
      suffix: '',
      labels: { module: r.consumer },
      value: r.oldestPendingSeconds,
    })),
  },
  {
    name: 'purlay_outbox_held',
    help: 'Facts waiting on purpose for a module, as this node sees them: the workspace is not granted it, this node does not run it, or the fact is of a newer shape.',
    type: 'gauge',
    samples: readings.flatMap((r) =>
      OUTBOX_HOLDS.map((reason) => ({
        suffix: '',
        labels: { module: r.consumer, reason },
        value: r.held[reason],
      })),
    ),
  },
  {
    name: 'purlay_outbox_dead',
    help: `Facts given up on after their tries, kept ${String(OUTBOX_DEAD_KEPT_DAYS)} days to be looked at, by the module that was to consume them.`,
    type: 'gauge',
    samples: readings.map((r) => ({ suffix: '', labels: { module: r.consumer }, value: r.dead })),
  },
  {
    name: 'purlay_outbox_expired_total',
    help: 'Facts given up on because nobody delivered them before their expiry, by the module that was to consume them and the fact type; read from the table the sweep counts in, the same on every node.',
    type: 'counter',
    samples: expired.map((e) => ({
      suffix: '',
      labels: { module: e.consumer, fact: e.type },
      value: e.expired,
    })),
  },
];

/** Reads the outbox for each scrape, bounded; a read that fails is said once and leaves the gauges out, never at zero. */
export const outboxMetrics = (dependencies: {
  readonly read: () => Promise<OutboxReport>;
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
      const report = await Promise.race([read(), late]);
      if (report === 'late') throw new Error(`no answer within ${String(timeoutMs)} ms`);
      failing = false;
      return outboxFamilies(report);
    } catch (error) {
      if (!failing) log.warn('the outbox could not be read for metrics', { err: error });
      failing = true;
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
};
