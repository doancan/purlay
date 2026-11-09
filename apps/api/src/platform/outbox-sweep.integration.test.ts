/**
 * What `sweep:outbox` takes and what it leaves (D-288 §9), on real PostgreSQL: a finished fact a day after it ended, a dead or discarded one
 * after the configured horizon (a hundred and eighty days unless said), a pending one past its expiry, and nothing that is in flight or still to be looked at.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { aMovableClock, NOW } from '../testing/doubles';
import { anOutboxRow, aWorkspaceRow } from '../testing/facts';
import { DAY_MS } from './clock';
import { sweepOutbox } from './outbox-sweep';

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

const clock = aMovableClock(NOW);
const DEAD_KEPT_DAYS = 180;
const sweep = async (deadKeptDays = DEAD_KEPT_DAYS): ReturnType<typeof sweepOutbox> =>
  await sweepOutbox({ database: cloned.db, clock, deadKeptDays });
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const remaining = async (workspaceId: string): Promise<string[]> =>
  (
    await cloned.db
      .selectFrom('outbox')
      .select(['state', 'created_at'])
      .where('workspace_id', '=', workspaceId)
      .execute()
  )
    .map((row) => `${row.state}@${String((NOW.getTime() - row.created_at.getTime()) / DAY_MS)}d`)
    .sort();

describe('integration: sweeping the outbox', () => {
  test('takes a delivered or skipped fact a day after it ended, and keeps the hour-old', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { state: 'delivered', at: ago(2 * DAY_MS) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'skipped', at: ago(2 * DAY_MS) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'delivered', at: ago(3_600_000) });
    expect(await sweep()).toEqual({
      finished: 2,
      dead: 0,
      discarded: 0,
      expired: 0,
    });
    expect(await remaining(workspaceId)).toEqual(['delivered@0.041666666666666664d']);
  });

  test('does not sweep a dead fact before the horizon, as it did at thirty days, and takes it after', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    for (const days of [31, 100, 179, 181])
      await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(days * DAY_MS) });
    expect(await sweep()).toEqual({ finished: 0, dead: 1, discarded: 0, expired: 0 });
    expect(await remaining(workspaceId)).toEqual(['dead@100d', 'dead@179d', 'dead@31d']);
  });

  test('takes a discarded fact at the same horizon and counts it apart from the dead', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { state: 'discarded', at: ago(179 * DAY_MS) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'discarded', at: ago(181 * DAY_MS) });
    await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(181 * DAY_MS) });
    expect(await sweep()).toEqual({ finished: 0, dead: 1, discarded: 1, expired: 0 });
    expect(await remaining(workspaceId)).toEqual(['discarded@179d']);
  });

  test('keeps a dead fact as long as the operator said, longer or shorter than the default', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { state: 'dead', at: ago(31 * DAY_MS) });
    expect(await sweep(365)).toEqual({ finished: 0, dead: 0, discarded: 0, expired: 0 });
    expect(await sweep(30)).toEqual({ finished: 0, dead: 1, discarded: 0, expired: 0 });
  });

  test('takes a pending fact past its expiry, counted as expired, and leaves one in flight', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    await anOutboxRow(cloned.db, workspaceId, { at: ago(3 * DAY_MS), expiresAt: ago(2 * DAY_MS) });
    await anOutboxRow(cloned.db, workspaceId, { at: ago(3_600_000) });
    await anOutboxRow(cloned.db, workspaceId, {
      at: ago(5 * DAY_MS),
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    expect(await sweep()).toEqual({
      finished: 0,
      dead: 0,
      discarded: 0,
      expired: 1,
    });
    expect(await remaining(workspaceId)).toHaveLength(2);
  });

  test('goes on past one batch and stops when a batch comes back short', async () => {
    const workspaceId = await aWorkspaceRow(cloned.db);
    const long = ago(10 * DAY_MS);
    await sql`
      insert into outbox (id, fact_id, workspace_id, type, producer, consumer, payload, state, next_attempt_at, created_at, finished_at, expires_at)
      select uuidv7(), uuidv7(), ${workspaceId}, 'notes.created', 'notes', 'wiki', '{"noteId":"n","title":"t"}'::jsonb, 'delivered', ${long}, ${long}, ${long}, ${long}
      from generate_series(1, 5003)`.execute(cloned.db);
    expect(await sweep()).toEqual({
      finished: 5003,
      dead: 0,
      discarded: 0,
      expired: 0,
    });
  });
});
