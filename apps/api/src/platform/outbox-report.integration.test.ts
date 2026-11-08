/**
 * What the operator is told of the outbox (D-288 §9), on real PostgreSQL: for each consuming module the facts waiting, how long the
 * oldest has waited and the facts that are dead, as gauges of a closed set of series and as the overview's two numbers.
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
import { anOutboxRow, aWorkspaceRow } from '../testing/facts';
import { outboxFamilies, outboxMetrics, outboxOverview, readOutbox } from './outbox-report';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
beforeEach(async () => {
  await sql`delete from outbox`.execute(cloned.db);
});
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;

describe('integration: reading the outbox for the operator', () => {
  test('counts what waits, how long the oldest has, and what is dead, for each consumer asked about', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { at: ago(20 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { at: ago(5 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(3 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'delivered', at: ago(90 * MINUTE) });
    await anOutboxRow(cloned.db, workspaceId, { consumer: 'shelf', at: ago(1 * MINUTE) });
    const readings = await readOutbox(cloned.db, ['wiki', 'shelf', 'quiet'], NOW);
    expect(readings).toEqual([
      { consumer: 'wiki', pending: 2, oldestPendingSeconds: 20 * 60, dead: 1 },
      { consumer: 'shelf', pending: 1, oldestPendingSeconds: 60, dead: 0 },
      { consumer: 'quiet', pending: 0, oldestPendingSeconds: 0, dead: 0 },
    ]);
  });

  test('reads no consumer that was not asked about, and nothing at all when none is', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { consumer: 'other', at: ago(MINUTE) });
    expect(await readOutbox(cloned.db, ['wiki'], NOW)).toEqual([
      { consumer: 'wiki', pending: 0, oldestPendingSeconds: 0, dead: 0 },
    ]);
    expect(await readOutbox(cloned.db, [], NOW)).toEqual([]);
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
    expect(outboxOverview(await readOutbox(cloned.db, ['wiki', 'shelf'], NOW))).toEqual({
      deadFacts: 2,
      oldestPendingSeconds: 11 * 60,
    });
    expect(outboxOverview([])).toEqual({ deadFacts: 0, oldestPendingSeconds: 0 });
  });

  test('is three gauges with one series for each module, at zero for a module with nothing in flight', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(MINUTE) });
    const families = outboxFamilies(await readOutbox(cloned.db, ['wiki', 'shelf'], NOW));
    expect(families.map((family) => family.name)).toEqual([
      'purlay_outbox_pending',
      'purlay_outbox_oldest_age_seconds',
      'purlay_outbox_dead',
    ]);
    const dead = families.find((family) => family.name === 'purlay_outbox_dead');
    expect(dead?.samples.map((sample) => [sample.labels, sample.value])).toEqual([
      [{ module: 'wiki' }, 1],
      [{ module: 'shelf' }, 0],
    ]);
  });
});

describe('integration: the page when the outbox cannot be read', () => {
  test('says so once in the log and leaves the gauges out, so a failure is not a zero', async () => {
    const { log, lines } = aRecordingLogger();
    let fail = true;
    const read = outboxMetrics({
      read: () => (fail ? Promise.reject(new Error('the database is away')) : Promise.resolve([])),
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
