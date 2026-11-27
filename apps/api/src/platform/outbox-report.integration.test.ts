/**
 * What the operator is told of the outbox (D-288 §9, D-353), on real PostgreSQL: for each consuming module the facts waiting, how long
 * the oldest this node would deliver has waited, the facts held on purpose and why, and the facts that are dead, as gauges of a closed
 * set of series and as the overview's two numbers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { aRecordingLogger, NOW } from '../testing/doubles';
import { aGrant, anOutboxRow, aWorkspaceRow, theGrants } from '../testing/facts';
import type { Handled } from './outbox-drain';
import {
  outboxFamilies,
  outboxMetrics,
  outboxOverview,
  readExpired,
  readOutbox,
  readOutboxReport,
  type OutboxView,
} from './outbox-report';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
beforeEach(async () => {
  await sql`delete from outbox`.execute(cloned.db);
  await sql`delete from outbox_expired`.execute(cloned.db);
});
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What a node that runs `wiki` and `shelf` delivers: `notes.created` to both and `notes.pinned` to wiki, of the first shape. */
const BOTH: readonly Handled[] = [
  { consumer: 'wiki', type: 'notes.created', shape: 1 },
  { consumer: 'wiki', type: 'notes.pinned', shape: 1 },
  { consumer: 'shelf', type: 'notes.created', shape: 1 },
];

const viewOf = (consumers: readonly string[], handles = BOTH): OutboxView => ({
  consumers,
  consumed: handles.map(({ consumer, type }) => ({ consumer, type })),
  handles: () => handles,
  effective: theGrants(),
  granted: theGrants(),
});

const NONE_HELD = { not_granted: 0, not_run: 0, newer_shape: 0 };

describe('integration: reading the outbox for the operator', () => {
  test('counts what waits, how long the oldest has, and what is dead, for each consumer asked about', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { at: ago(20 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { at: ago(5 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(3 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'delivered', at: ago(90 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { consumer: 'shelf', at: ago(1 * MINUTE) });
    const readings = await readOutbox(cloned.db, viewOf(['wiki', 'shelf', 'quiet']), NOW);
    expect(readings).toEqual([
      { consumer: 'wiki', pending: 2, oldestPendingSeconds: 20 * 60, held: NONE_HELD, dead: 1 },
      { consumer: 'shelf', pending: 1, oldestPendingSeconds: 60, held: NONE_HELD, dead: 0 },
      // A consumer this node delivers nothing of holds nothing when nothing waits.
      { consumer: 'quiet', pending: 0, oldestPendingSeconds: 0, held: NONE_HELD, dead: 0 },
    ]);
  });

  test('reads no consumer that was not asked about, and nothing at all when none is', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { consumer: 'other', at: ago(MINUTE) });
    expect(await readOutbox(cloned.db, viewOf(['wiki']), NOW)).toEqual([
      { consumer: 'wiki', pending: 0, oldestPendingSeconds: 0, held: NONE_HELD, dead: 0 },
    ]);
    expect(await readOutbox(cloned.db, viewOf([]), NOW)).toEqual([]);
    expect(await readOutboxReport(cloned.db, viewOf([], []), NOW)).toEqual({
      readings: [],
      expired: [],
    });
  });

  test('measures the wait from when a fact was published, not from when it is next tried', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { at: ago(30 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { at: ago(2 * MINUTE) });
    await sql`update outbox set next_attempt_at = ${new Date(NOW.getTime() + 60 * MINUTE)}`.execute(
      cloned.db,
    );
    expect(await readOutbox(cloned.db, viewOf(['wiki']), NOW)).toEqual([
      { consumer: 'wiki', pending: 2, oldestPendingSeconds: 30 * 60, held: NONE_HELD, dead: 0 },
    ]);
  });

  test('has the index that makes the oldest wait the first entry of a consumer, not a minimum of its rows', async () => {
    const { rows } = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where tablename = 'outbox' and indexname = 'idx_outbox_pending_age'
    `.execute(cloned.db);
    expect(rows[0]?.indexdef).toMatch(/\(consumer, created_at\) WHERE \(state = 'pending'/);
  });

  test('is, for the overview, the dead facts of every consumer and the longest wait of any', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(3 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, {
      state: 'dead',
      consumer: 'shelf',
      at: ago(MINUTE),
    });
    await anOutboxRow(cloned.db, workspaceId, { at: ago(7 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { consumer: 'shelf', at: ago(11 * MINUTE) });
    expect(outboxOverview(await readOutbox(cloned.db, viewOf(['wiki', 'shelf']), NOW))).toEqual({
      deadFacts: 2,
      oldestPendingSeconds: 11 * 60,
    });
    expect(outboxOverview([])).toEqual({ deadFacts: 0, oldestPendingSeconds: 0 });
  });

  test('is four gauges with one series for each module (and reason), at zero for a module with nothing in flight', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { at: ago(MINUTE), shape: 2 });
    const families = outboxFamilies(
      await readOutboxReport(cloned.db, viewOf(['wiki', 'shelf']), NOW),
    );
    expect(families.map((family) => family.name)).toEqual([
      'purlay_outbox_pending',
      'purlay_outbox_oldest_age_seconds',
      'purlay_outbox_held',
      'purlay_outbox_dead',
      'purlay_outbox_expired_total',
    ]);
    const samplesOf = (name: string): unknown[] | undefined =>
      families
        .find((family) => family.name === name)
        ?.samples.map((sample) => [sample.labels, sample.value]);
    expect(samplesOf('purlay_outbox_dead')).toEqual([
      [{ module: 'wiki' }, 1],
      [{ module: 'shelf' }, 0],
    ]);
    expect(samplesOf('purlay_outbox_held')).toEqual([
      [{ module: 'wiki', reason: 'not_granted' }, 0],
      [{ module: 'wiki', reason: 'not_run' }, 0],
      [{ module: 'wiki', reason: 'newer_shape' }, 1],
      [{ module: 'shelf', reason: 'not_granted' }, 0],
      [{ module: 'shelf', reason: 'not_run' }, 0],
      [{ module: 'shelf', reason: 'newer_shape' }, 0],
    ]);
  });
});

describe('integration: the facts that expired undelivered (D-353)', () => {
  test('are the sweep’s counts, with a zero for each pair the build consumes and none counted yet', async () => {
    await cloned.db
      .insertInto('outbox_expired')
      .values([
        { consumer: 'wiki', type: 'notes.created', expired: '3', last_expired_at: NOW },
        // A pair the build no longer consumes still happened, and stays in the counter.
        { consumer: 'gone', type: 'gone.made', expired: '2', last_expired_at: NOW },
      ])
      .execute();
    const expired = await readExpired(cloned.db, viewOf(['wiki', 'shelf']).consumed);
    expect(expired).toEqual([
      { consumer: 'gone', type: 'gone.made', expired: 2 },
      { consumer: 'wiki', type: 'notes.created', expired: 3 },
      { consumer: 'wiki', type: 'notes.pinned', expired: 0 },
      { consumer: 'shelf', type: 'notes.created', expired: 0 },
    ]);
    const counter = outboxFamilies({ readings: [], expired }).find(
      (family) => family.name === 'purlay_outbox_expired_total',
    );
    expect(counter?.type).toBe('counter');
    expect(counter?.samples[1]).toEqual({
      suffix: '',
      labels: { module: 'wiki', fact: 'notes.created' },
      value: 3,
    });
  });
});

describe('integration: a fact held on purpose is not a late one (D-353)', () => {
  test('a workspace not granted the consumer, and a shape newer than the node reads, are held and not the age', async () => {
    const barred = await aWorkspaceRow(cloned.db);
    const granted = await aWorkspaceRow(cloned.db);
    await aGrant(cloned.db, barred, 'wiki', 'off');
    await anOutboxRow(cloned.db, barred, { at: ago(3 * HOUR) });
    await anOutboxRow(cloned.db, barred, { at: ago(2 * HOUR), type: 'notes.pinned' });
    await anOutboxRow(cloned.db, granted, { at: ago(2 * HOUR), shape: 2 });
    await anOutboxRow(cloned.db, granted, { at: ago(10 * MINUTE) });
    // Past its expiry: neither late nor held, but the sweep's to count (D-353).
    await anOutboxRow(cloned.db, granted, { at: ago(5 * HOUR), expiresAt: ago(MINUTE) });
    expect(await readOutbox(cloned.db, viewOf(['wiki']), NOW)).toEqual([
      {
        consumer: 'wiki',
        pending: 5,
        oldestPendingSeconds: 10 * 60,
        held: { not_granted: 2, not_run: 0, newer_shape: 1 },
        dead: 0,
      },
    ]);
  });

  test('a consumer this node does not run, or has stopped, holds what it has, so the age is the node that runs it', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { at: ago(3 * HOUR) });
    await anOutboxRow(cloned.db, workspaceId, { consumer: 'shelf', at: ago(2 * HOUR) });
    const wikiAlone = BOTH.filter(({ consumer }) => consumer === 'wiki');
    expect(await readOutbox(cloned.db, viewOf(['wiki', 'shelf'], wikiAlone), NOW)).toEqual([
      { consumer: 'wiki', pending: 1, oldestPendingSeconds: 3 * 60 * 60, held: NONE_HELD, dead: 0 },
      {
        consumer: 'shelf',
        pending: 1,
        oldestPendingSeconds: 0,
        held: { not_granted: 0, not_run: 1, newer_shape: 0 },
        dead: 0,
      },
    ]);
  });

  test('a row in its backoff is late and not held: it counts in the age', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { at: ago(2 * HOUR), attempts: 3 });
    await sql`update outbox set next_attempt_at = ${new Date(NOW.getTime() + HOUR)}`.execute(
      cloned.db,
    );
    expect(outboxOverview(await readOutbox(cloned.db, viewOf(['wiki']), NOW))).toEqual({
      deadFacts: 0,
      oldestPendingSeconds: 2 * 60 * 60,
    });
  });
});

describe('integration: the page when the outbox cannot be read', () => {
  test('says so once in the log and leaves the gauges out, so a failure is not a zero', async () => {
    const { log, lines } = aRecordingLogger();
    let fail = true;
    const read = outboxMetrics({
      read: () =>
        fail
          ? Promise.reject(new Error('the database is away'))
          : Promise.resolve({ readings: [], expired: [] }),
      log,
    });
    expect(await read()).toEqual([]);
    expect(await read()).toEqual([]);
    expect(lines.filter((line) => line['level'] === 'warn')).toHaveLength(1);
    fail = false;
    expect((await read()).map((family) => family.name)).toContain('purlay_outbox_dead');
  });

  test('gives up on a read that does not answer in its time', async () => {
    const { log } = aRecordingLogger();
    const read = outboxMetrics({ read: () => new Promise(() => undefined), log, timeoutMs: 20 });
    expect(await read()).toEqual([]);
  });
});
