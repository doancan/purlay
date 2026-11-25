/**
 * What an operator does with a workspace's limits (#1306): sets one with a reason, reads what is in force, clears it. A change is
 * on the workspace's trail with which, from and to and never the reason; the same command again changes and records nothing; and a
 * limit of one workspace is never another's. Real PostgreSQL, through the command's own words (`runQuota`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  closeIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { limitFor } from '../../platform/quotas';
import { atomicallyOn } from '../../platform/transactions';
import { aWorkspaceRow } from '../../testing/facts';
import { runQuota, type QuotaRun } from './command';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const run = async (...argv: string[]): Promise<QuotaRun> =>
  await runQuota(argv, {
    atomically: async (work) => await atomicallyOn(cloned.db)(async (tx) => await work(tx)),
    clock: systemClock,
    defaults: { deliveries_per_minute: null, 'issues:rows': 10_000 },
  });

/** A workspace of its own, by its address. */
const aWorkspace = async (db: Executor): Promise<{ id: string; slug: string }> => {
  const id = await aWorkspaceRow(db);
  const row = await db
    .selectFrom('workspaces')
    .select('slug')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return { id, slug: row.slug };
};

const trailOf = async (
  db: Executor,
  workspaceId: string,
): Promise<{ actor: string | null; metadata: unknown }[]> =>
  (
    await db
      .selectFrom('audit_log')
      .select(['actor_user_id', 'metadata'])
      .where('workspace_id', '=', workspaceId)
      .where('action', '=', 'quota.changed')
      .orderBy('id')
      .execute()
  ).map((row) => ({ actor: row.actor_user_id, metadata: row.metadata }));

describe('integration: an operator’s limits for a workspace', () => {
  test('sets a limit with its reason, reads it back as in force, and puts it on the trail without the reason', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    const set = await run('set', slug, 'deliveries_per_minute', '120', '--reason', 'a loud import');
    expect(set).toMatchObject({ code: 0, err: '' });
    expect(set.out).toContain('deliveries_per_minute of');
    expect(set.out).toContain('120');
    expect(await limitFor(cloned.db, id, 'deliveries_per_minute', null)).toBe(120);
    const shown = await run('show', slug);
    expect(shown.out).toContain('deliveries_per_minute (queued deliveries per minute): 120');
    expect(shown.out).toContain('a loud import');
    expect(shown.out).toContain('issues:rows (issues held): 10000 [default]');
    // On the trail: which, to, with nobody as the actor; the words of the reason stay in the row.
    const trail = await trailOf(cloned.db, id);
    expect(trail).toEqual([
      { actor: null, metadata: { kind: 'deliveries_per_minute', to: '120' } },
    ]);
    expect(JSON.stringify(trail)).not.toContain('a loud import');
  });

  test('the same command again changes and records nothing; another limit records from and to; clearing says the default', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    await run('set', slug, 'issues:rows', '50', '--reason', 'a small team');
    const again = await run('set', slug, 'issues:rows', '50', '--reason', 'a small team');
    expect(again.out).toContain('(no change)');
    expect(await trailOf(cloned.db, id)).toHaveLength(1);
    await run('set', slug, 'issues:rows', '80', '--reason', 'grew');
    const cleared = await run('clear', slug, 'issues:rows');
    expect(cleared.out).toContain('back to the default');
    const clearedAgain = await run('clear', slug, 'issues:rows');
    expect(clearedAgain.out).toContain('(no change)');
    expect((await trailOf(cloned.db, id)).map((entry) => entry.metadata)).toEqual([
      { kind: 'issues:rows', to: '50' },
      { kind: 'issues:rows', from: '50', to: '80' },
      { kind: 'issues:rows', from: '80' },
    ]);
    expect(await limitFor(cloned.db, id, 'issues:rows', 10_000)).toBe(10_000);
  });

  test('a limit is read for its own workspace and its own kind: another’s row, or another kind’s, is not it', async () => {
    const mine = await aWorkspace(cloned.db);
    const theirs = await aWorkspace(cloned.db);
    await run('set', theirs.slug, 'deliveries_per_minute', '7', '--reason', 'theirs');
    await run('set', mine.slug, 'issues:rows', '3', '--reason', 'mine');
    expect(await limitFor(cloned.db, mine.id, 'deliveries_per_minute', null)).toBeNull();
    expect(await limitFor(cloned.db, mine.id, 'issues:rows', null)).toBe(3);
    expect(await limitFor(cloned.db, theirs.id, 'issues:rows', null)).toBeNull();
    expect(await limitFor(cloned.db, theirs.id, 'deliveries_per_minute', null)).toBe(7);
  });

  test('a new reason for the same limit is kept and shown, and records nothing on the trail', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    await run('set', slug, 'issues:rows', '50', '--reason', 'first words');
    const again = await run('set', slug, 'issues:rows', '50', '--reason', 'better words');
    expect(again.out).toContain('(no change)');
    expect((await run('show', slug)).out).toContain('better words');
    expect(await trailOf(cloned.db, id)).toHaveLength(1);
  });

  test('a reason is at most 500 characters: 500 is kept, 501 is refused with the command’s own message and writes nothing', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    const refused = await run('set', slug, 'issues:rows', '5', '--reason', 'x'.repeat(501));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('at most 500');
    expect(await limitFor(cloned.db, id, 'issues:rows', null)).toBeNull();
    expect((await run('set', slug, 'issues:rows', '5', '--reason', 'x'.repeat(500))).code).toBe(0);
  });

  test('0 is a limit, and refuses what is new', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    expect((await run('set', slug, 'issues:rows', '0', '--reason', 'frozen')).code).toBe(0);
    expect(await limitFor(cloned.db, id, 'issues:rows', 10_000)).toBe(0);
  });

  test('a limit of one workspace is not another’s', async () => {
    const mine = await aWorkspace(cloned.db);
    const theirs = await aWorkspace(cloned.db);
    await run('set', mine.slug, 'deliveries_per_minute', '1', '--reason', 'noisy');
    expect(await limitFor(cloned.db, mine.id, 'deliveries_per_minute', null)).toBe(1);
    expect(await limitFor(cloned.db, theirs.id, 'deliveries_per_minute', null)).toBeNull();
    expect(await trailOf(cloned.db, theirs.id)).toEqual([]);
    expect((await run('show', theirs.slug)).out).not.toContain('noisy');
  });

  test('refuses, writing nothing, a set with no reason, a limit that is not a whole number, a kind nobody knows and a workspace that is not there', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    for (const argv of [
      ['set', slug, 'issues:rows', '10'],
      ['set', slug, 'issues:rows', '10', '--reason', '   '],
      ['set', slug, 'issues:rows', '-1', '--reason', 'x'],
      ['set', slug, 'issues:rows', '1.5', '--reason', 'x'],
      ['set', slug, 'issues:rows', 'many', '--reason', 'x'],
      ['set', slug, 'issues:rows', '99999999999999999', '--reason', 'x'],
      ['set', slug, 'storage_bytes', '10', '--reason', 'x'],
      ['set', slug, 'issues:rows', '10', '--reason', 'x', 'extra'],
      ['set', 'no-such-workspace', 'issues:rows', '10', '--reason', 'x'],
      ['clear', slug, 'nothing'],
      ['clear', 'no-such-workspace', 'issues:rows'],
      ['show', 'no-such-workspace'],
      ['show'],
      ['frobnicate', slug],
    ]) {
      const refused = await run(...argv);
      expect(refused.code, argv.join(' ')).toBe(2);
      expect(refused.err, argv.join(' ')).not.toBe('');
    }
    expect(await limitFor(cloned.db, id, 'issues:rows', null)).toBeNull();
    expect(await trailOf(cloned.db, id)).toEqual([]);
  });

  test('a deleted workspace is not there', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    await cloned.db
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .execute();
    expect((await run('set', slug, 'issues:rows', '10', '--reason', 'x')).code).toBe(2);
  });

  test('a limit goes with its workspace', async () => {
    const { id, slug } = await aWorkspace(cloned.db);
    await run('set', slug, 'issues:rows', '10', '--reason', 'x');
    // The trail of a workspace is kept while it lives (the purge takes it with the rest); the limits go with the row.
    await cloned.db.deleteFrom('audit_log').where('workspace_id', '=', id).execute();
    await cloned.db.deleteFrom('workspaces').where('id', '=', id).execute();
    const left = await cloned.db
      .selectFrom('workspace_quotas')
      .select('kind')
      .where('workspace_id', '=', id)
      .execute();
    expect(left).toEqual([]);
  });
});
