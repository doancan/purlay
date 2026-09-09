/**
 * The half a compiler cannot check: what a stranger actually receives.
 *
 * `tenancy.test.ts` proves a workspace-scoped call cannot be written without a
 * context. This proves the guard only hands one out to a member, and that every
 * other answer is the same answer — 404 carrying nothing (D-21).
 *
 * It also proves the type is inhabited at runtime. An uninhabited brand would
 * make every compile-time assertion pass while meaning nothing.
 *
 * Real PostgreSQL, real migrations, inside a transaction that is rolled back
 * (D-46).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { AppError } from './errors';
import { requireWorkspaceMembership, type WorkspaceContext } from './tenancy';

afterAll(async () => {
  await closeIntegrationDatabase();
});

// The helpers take an executor, like everything else. `withRollback` hands out a
// `Transaction`, which is an `Executor` — that indistinguishability is the whole
// point of D-46, so the fixtures obey it too.
const addUser = async (db: Executor, name: string): Promise<string> => {
  const row = await db
    .insertInto('users')
    .values({ email: `${name}@example.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

const addWorkspace = async (db: Executor, slug: string): Promise<string> => {
  const row = await db
    .insertInto('workspaces')
    .values({ name: slug, slug })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

/** Stands in for a workspace-scoped repository: it cannot be called without one. */
const scopedRead = (context: WorkspaceContext): string => context.workspaceId;

/** The refusal, as the client would see it. Fails the test if anything else was thrown. */
const refusalFrom = async (body: () => Promise<unknown>): Promise<AppError> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('the guard returned a context where it was required to refuse');
};

describe('integration: the workspace membership guard', () => {
  test('a member receives a context, and it is accepted where one is required', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'guard-member');
      const workspaceId = await addWorkspace(db, 'guard-home');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: userId, role: 'admin' })
        .execute();

      const context = await requireWorkspaceMembership(db, userId, workspaceId);

      expect(context.workspaceId).toBe(workspaceId);
      expect(context.userId).toBe(userId);
      expect(context.role).toBe('admin');
      expect(scopedRead(context)).toBe(workspaceId);
    });
  });

  test('a stranger to the workspace gets 404, never 403', async () => {
    await withRollback(async (db) => {
      const outsiderId = await addUser(db, 'guard-outsider');
      const memberId = await addUser(db, 'guard-insider');
      const workspaceId = await addWorkspace(db, 'guard-theirs');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: memberId })
        .execute();

      const refusal = await refusalFrom(() =>
        requireWorkspaceMembership(db, outsiderId, workspaceId),
      );

      expect(refusal.status).toBe(404);
      expect(refusal.body.code).toBe('WORKSPACE_NOT_FOUND');
    });
  });

  /**
   * The disclosure D-21 is about. If "not yours" and "no such thing" differ in
   * any byte, the endpoint is an existence oracle: a stranger can enumerate which
   * workspace ids are real.
   */
  test('"not yours" and "does not exist" are the same response, byte for byte', async () => {
    await withRollback(async (db) => {
      const outsiderId = await addUser(db, 'guard-prober');
      const memberId = await addUser(db, 'guard-owner');
      const realId = await addWorkspace(db, 'guard-real');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: realId, user_id: memberId })
        .execute();

      const theirs = await refusalFrom(() => requireWorkspaceMembership(db, outsiderId, realId));
      const nothing = await refusalFrom(() =>
        // A well-formed id that belongs to no row at all.
        requireWorkspaceMembership(db, outsiderId, '00000000-0000-4000-8000-000000000000'),
      );

      expect(JSON.stringify(theirs.response)).toBe(JSON.stringify(nothing.response));
      expect(theirs.status).toBe(nothing.status);
    });
  });

  /**
   * A path parameter is whatever the caller typed. Handed straight to PostgreSQL
   * it raises on the UUID cast, and the boundary answers 500 where it promised
   * 404 — which separates malformed ids from missing ones and invents a status
   * the contract does not have.
   */
  test('an id that is not a UUID gets the same 404, not a 500', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'guard-typo');

      const refusal = await refusalFrom(() =>
        requireWorkspaceMembership(db, userId, "'; DROP TABLE workspaces; --"),
      );

      expect(refusal.status).toBe(404);
      expect(refusal.body.code).toBe('WORKSPACE_NOT_FOUND');
    });
  });

  /** A membership row can outlive its workspace. It must not mint anything. */
  test('a soft-deleted workspace is not a workspace you are a member of', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'guard-ghost');
      const workspaceId = await addWorkspace(db, 'guard-gone');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: userId, role: 'owner' })
        .execute();
      await db
        .updateTable('workspaces')
        // A fixed instant: a test that reads the clock is a test that can differ between runs.
        .set({ deleted_at: '2026-01-01T00:00:00.000Z' })
        .where('id', '=', workspaceId)
        .execute();

      const refusal = await refusalFrom(() => requireWorkspaceMembership(db, userId, workspaceId));

      expect(refusal.status).toBe(404);
    });
  });
});
