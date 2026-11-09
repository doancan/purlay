/**
 * The one writer of a workspace's grants, on a real database (D-289): what it refuses, what a repeat does, that a refusal in
 * the middle of a batch leaves none of it, and that a module is not granted to a workspace that lacks one it requires.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { NOW } from '../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { applyEntitlements, type EntitlementCatalogue, type EntitlementWrite } from './apply';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ACTOR = { source: 'file:editions.json', userId: null };

/** Three modules: `base`, `extra` which requires it, and chat’s kind, which no workspace is granted. */
const catalogue = (mode: EntitlementCatalogue['mode']): EntitlementCatalogue => ({
  mode,
  carried: [
    { id: 'chat', requires: [], entitlement: 'always' },
    { id: 'base', requires: [] },
    { id: 'extra', requires: ['base'] },
  ],
});

const aWorkspace = async (db: Executor): Promise<string> =>
  (
    await db
      .insertInto('workspaces')
      .values({ name: 'Grants', slug: aUniqueSlug('grants') })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

const write = (
  workspaceId: string,
  module: string,
  state: EntitlementWrite['state'],
  validUntil?: Date,
): EntitlementWrite => ({
  workspaceId,
  module,
  state,
  ...(validUntil === undefined ? {} : { validUntil }),
});

const rowsOf = async (db: Executor, workspaceId: string): Promise<string[]> =>
  (
    await db
      .selectFrom('workspace_modules')
      .select(['module', 'state'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('module')
      .execute()
  ).map((row) => `${row.module}:${row.state}`);

const trailOf = async (db: Executor): Promise<string[]> =>
  (
    await db
      .selectFrom('server_audit_log')
      .select(['action', 'target_module'])
      .where('action', 'like', 'server.module_%')
      .orderBy('id')
      .execute()
  ).map((row) => `${row.action} ${row.target_module ?? ''}`);

const apply = async (
  tx: Transaction,
  mode: EntitlementCatalogue['mode'],
  writes: readonly EntitlementWrite[],
): ReturnType<typeof applyEntitlements> =>
  await applyEntitlements(tx, clock, catalogue(mode), ACTOR, writes);

const code = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    return (error as { body?: { code?: string } }).body?.code ?? String(error);
  }
  return 'accepted';
};

describe('integration: the writer of a workspace’s grants', () => {
  test('writes the label of who wrote, answers only what changed, and a repeat or an absent row changes nothing', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const first = await apply(db, 'open', [
        write(workspaceId, 'base', 'off'),
        write(workspaceId, 'extra', 'inherit'),
      ]);
      expect(first).toEqual([{ workspaceId, module: 'base', state: 'off' }]);
      expect(await apply(db, 'open', [write(workspaceId, 'base', 'off')])).toEqual([]);
      const row = await db
        .selectFrom('workspace_modules')
        .select(['source', 'changed_by'])
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ source: 'file:editions.json', changed_by: null });
      expect(await trailOf(db)).toEqual(['server.module_withdrawn base']);
      // A different end is a change; the same end is not.
      const until = new Date(NOW.getTime() + 3_600_000);
      expect(await apply(db, 'open', [write(workspaceId, 'base', 'off', until)])).toHaveLength(1);
      expect(await apply(db, 'open', [write(workspaceId, 'base', 'off', until)])).toEqual([]);
    });
  });

  test('records who wrote when it is an administrator', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const admin = await aUserRow(db, 'granting-admin');
      await applyEntitlements(
        db,
        clock,
        catalogue('open'),
        { source: 'operator', userId: admin.userId },
        [write(workspaceId, 'base', 'off')],
      );
      const row = await db
        .selectFrom('workspace_modules')
        .select('changed_by')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      expect(row.changed_by).toBe(admin.userId);
      const entry = await db
        .selectFrom('server_audit_log')
        .select(['actor_user_id', 'target_workspace_id'])
        .where('action', '=', 'server.module_withdrawn')
        .executeTakeFirstOrThrow();
      expect(entry).toEqual({ actor_user_id: admin.userId, target_workspace_id: workspaceId });
    });
  });

  test('audits the end it set and what the row said before, with the operator’s word that every node reads grants when it was given', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const until = new Date(NOW.getTime() + 3_600_000);
      const later = new Date(NOW.getTime() + 7_200_000);
      const detailOf = async (): Promise<unknown[]> =>
        (
          await db
            .selectFrom('server_audit_log')
            .select([
              'action',
              'module_state_before',
              'module_valid_until',
              'module_valid_until_before',
              'cluster_ready_asserted',
            ])
            .where('target_workspace_id', '=', workspaceId)
            .orderBy('id')
            .execute()
        ).map((row) => [
          row.action,
          row.module_state_before,
          row.module_valid_until?.getTime() ?? null,
          row.module_valid_until_before?.getTime() ?? null,
          row.cluster_ready_asserted,
        ]);
      // No row before: the server's mode decided, so there was no state to record.
      await apply(db, 'open', [write(workspaceId, 'base', 'on', until)]);
      // The end moves from one to another, the state stays.
      await apply(db, 'open', [write(workspaceId, 'base', 'on', later)]);
      // A withdrawal records what it took away, and the operator's word when the command had it.
      await applyEntitlements(db, clock, catalogue('managed'), { ...ACTOR, clusterReady: true }, [
        write(workspaceId, 'base', 'off'),
      ]);
      // Removing the row records the withdrawal it ends.
      await apply(db, 'open', [write(workspaceId, 'base', 'inherit')]);
      // The clock stands still in this test, so the trail's order is not the order written: compared as a set.
      expect((await detailOf()).map((row) => JSON.stringify(row)).sort()).toEqual(
        [
          ['server.module_granted', null, until.getTime(), null, null],
          ['server.module_granted', 'on', later.getTime(), until.getTime(), null],
          ['server.module_withdrawn', 'on', null, later.getTime(), true],
          ['server.module_reset', 'off', null, null, null],
        ]
          .map((row) => JSON.stringify(row))
          .sort(),
      );
    });
  });

  test('refuses what it must, by name, before it writes anything', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const tx = db;
      const past = new Date(NOW.getTime() - 1);
      expect(await code(apply(tx, 'open', [write(workspaceId, 'tasks', 'on')]))).toBe(
        'VALIDATION_FAILED',
      );
      expect(await code(apply(tx, 'open', [write(workspaceId, 'chat', 'off')]))).toBe(
        'VALIDATION_FAILED',
      );
      expect(await code(apply(tx, 'open', [write(workspaceId, 'base', 'on', past)]))).toBe(
        'VALIDATION_FAILED',
      );
      expect(await code(apply(tx, 'open', [write(workspaceId, 'base', 'on', NOW)]))).toBe(
        'VALIDATION_FAILED',
      );
      expect(
        await code(
          apply(tx, 'open', [
            write(workspaceId, 'base', 'inherit', new Date(NOW.getTime() + 1_000)),
          ]),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(await code(apply(tx, 'open', [write(crypto.randomUUID(), 'base', 'on')]))).toBe(
        'WORKSPACE_NOT_FOUND',
      );
      await db
        .updateTable('workspaces')
        .set({ deleted_at: NOW })
        .where('id', '=', workspaceId)
        .execute();
      expect(await code(apply(tx, 'open', [write(workspaceId, 'base', 'on')]))).toBe(
        'WORKSPACE_NOT_FOUND',
      );
      expect(await rowsOf(db, workspaceId)).toEqual([]);
      expect(await trailOf(db)).toEqual([]);
    });
  });

  test('a batch with one write refused writes none of the others', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      // `validate` runs before the first write, so the good write before the bad one is not made.
      const attempt = apply(db, 'open', [
        write(workspaceId, 'base', 'off'),
        write(workspaceId, 'tasks', 'off'),
      ]);
      expect(await code(attempt)).toBe('VALIDATION_FAILED');
      expect(await rowsOf(db, workspaceId)).toEqual([]);
    });
  });

  test('does not grant a module to a workspace that lacks one it requires, in either mode and in either order of a batch', async () => {
    await withRollback(async (db) => {
      const managed = await aWorkspace(db);
      const tx = db;
      expect(await code(apply(tx, 'managed', [write(managed, 'extra', 'on')]))).toBe(
        'MODULE_REQUIRES',
      );
      // The same batch with the requirement first, and with it last.
      await db.deleteFrom('workspace_modules').where('workspace_id', '=', managed).execute();
      expect(
        await apply(tx, 'managed', [write(managed, 'base', 'on'), write(managed, 'extra', 'on')]),
      ).toHaveLength(2);
      await db.deleteFrom('workspace_modules').where('workspace_id', '=', managed).execute();
      expect(
        await apply(tx, 'managed', [write(managed, 'extra', 'on'), write(managed, 'base', 'on')]),
      ).toHaveLength(2);

      const open = await aWorkspace(db);
      await apply(tx, 'open', [write(open, 'base', 'off')]);
      expect(await code(apply(tx, 'open', [write(open, 'extra', 'on')]))).toBe('MODULE_REQUIRES');
      expect(await rowsOf(db, open)).toEqual(['base:off']);
    });
  });

  test('is silent about a module the workspace is withdrawn when only its dependant remains granted (a downgrade, not a refusal)', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const tx = db;
      await apply(tx, 'managed', [
        write(workspaceId, 'base', 'on'),
        write(workspaceId, 'extra', 'on'),
      ]);
      expect(await apply(tx, 'managed', [write(workspaceId, 'base', 'off')])).toHaveLength(1);
      expect(await rowsOf(db, workspaceId)).toEqual(['base:off', 'extra:on']);
    });
  });
});
