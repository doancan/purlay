/**
 * The administration tables as migration 0019 makes them (`SCHEMA.md` §9): what the audit trail
 * refuses and keeps, and what a job's record holds. One refusal per transaction, and last in it:
 * a refused statement ends the transaction it ran in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import pg from 'pg';
import type { Executor } from './client';
import { closeIntegrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');

/** The constraint the database refused with; a failure of the test if it refused nothing. */
const refusedBy = async (attempt: () => Promise<unknown>): Promise<string> => {
  try {
    await attempt();
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error.constraint ?? '';
    throw error;
  }
  throw new Error('the database accepted what it should have refused');
};

const aWorkspaceAndActor = async (
  db: Executor,
): Promise<{ workspaceId: string; actorId: string }> => {
  const actorId = (
    await db
      .insertInto('users')
      .values({ email: 'admin@example.test', username: 'admin0019', display_name: 'Admin' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const workspaceId = (
    await db
      .insertInto('workspaces')
      .values({ name: 'audit', slug: `audit-${crypto.randomUUID().slice(0, 8)}` })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  return { workspaceId, actorId };
};

const anEntry = (
  db: Executor,
  at: { workspaceId: string; actorId?: string },
  id: string = Bun.randomUUIDv7('hex', NOW),
): Promise<unknown> =>
  db
    .insertInto('audit_log')
    .values({
      id,
      workspace_id: at.workspaceId,
      actor_user_id: at.actorId ?? null,
      action: 'member.role_changed',
      target_type: 'user',
    })
    .execute();

describe('integration: the audit trail', () => {
  test('takes the application’s UUIDv7 only, as messages do (D-8)', async () => {
    await withRollback(async (db) => {
      const at = await aWorkspaceAndActor(db);
      expect(await refusedBy(() => anEntry(db, at, crypto.randomUUID()))).toBe(
        'audit_log_id_is_uuidv7',
      );
    });
  });

  test('keeps what was done when the actor is erased (D-27)', async () => {
    await withRollback(async (db) => {
      const at = await aWorkspaceAndActor(db);
      const id = Bun.randomUUIDv7('hex', NOW);
      await anEntry(db, at, id);
      await db.deleteFrom('users').where('id', '=', at.actorId).execute();
      const kept = await db
        .selectFrom('audit_log')
        .select(['action', 'actor_user_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({ action: 'member.role_changed', actor_user_id: null });
    });
  });

  test('outlives a hard purge of its workspace: the delete is refused', async () => {
    await withRollback(async (db) => {
      const at = await aWorkspaceAndActor(db);
      await anEntry(db, { workspaceId: at.workspaceId });
      expect(
        await refusedBy(() =>
          db.deleteFrom('workspaces').where('id', '=', at.workspaceId).execute(),
        ),
      ).toBe('audit_log_workspace_id_fkey');
    });
  });
});

describe('integration: a job’s record', () => {
  test('never counts its failures below zero', async () => {
    await withRollback(async (db) => {
      await db.insertInto('job_runs').values({ job_name: 'sweep:test-0019' }).execute();
      expect(
        await refusedBy(() =>
          db
            .updateTable('job_runs')
            .set({ consecutive_failures: -1 })
            .where('job_name', '=', 'sweep:test-0019')
            .execute(),
        ),
      ).toBe('consecutive_failures_non_negative');
    });
  });

  test('is one row per job, upserted, and belongs to no workspace', async () => {
    await withRollback(async (db) => {
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns where table_name = 'job_runs'
      `.execute(db);
      expect(columns.rows.map((row) => row.column_name)).not.toContain('workspace_id');
      await db.insertInto('job_runs').values({ job_name: 'sweep:test-0019' }).execute();
      expect(
        await refusedBy(() =>
          db.insertInto('job_runs').values({ job_name: 'sweep:test-0019' }).execute(),
        ),
      ).toBe('job_runs_pkey');
    });
  });
});
