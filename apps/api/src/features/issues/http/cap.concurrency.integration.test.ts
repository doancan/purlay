/**
 * Two makes at the cap cannot both be the last (D-254): the count is taken under the workspace's row locked, so the
 * second waits for the first's commit and finds the workspace full. On a cloned database, because commit order is the
 * behaviour under test and the harness's one rolled-back transaction has none (D-46).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { ISSUES_PER_WORKSPACE_MAX } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { NOW } from '../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { createIssue } from '../../features/issues/issues';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

describe('integration: making issues at the cap, together', () => {
  test('one of two makes at one below the cap is the last, and the other is refused ISSUES_LIMIT', async () => {
    const user = await aUserRow(cloned.db, 'cap');
    const workspace = await cloned.db
      .insertInto('workspaces')
      .values({ name: 'W', slug: aUniqueSlug('cap') })
      .returning('id')
      .executeTakeFirstOrThrow();
    await cloned.db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: user.userId, role: 'owner' })
      .execute();
    await sql`
      insert into issues (id, workspace_id, title, created_by)
      select ('0199155c-' || lpad(to_hex(n / 65536), 4, '0') || '-7b7f-8c11-' || lpad(to_hex(n % 65536), 12, '0'))::uuid,
             ${workspace.id}, 'filler', ${user.userId}
      from generate_series(1, ${ISSUES_PER_WORKSPACE_MAX - 1}) as n`.execute(cloned.db);

    const make = async (title: string): Promise<string> =>
      await atomicallyOn(cloned.db)(async (transaction) => {
        const context = await requireWorkspaceMembership(transaction, user.userId, workspace.id);
        await createIssue(transaction, fixedClock(NOW), context, { title });
        // Held a moment, so that the other has looked before this commits.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return 'made';
      }).catch((error: unknown) => (error instanceof AppError ? error.body.code : String(error)));
    const outcomes = await Promise.all([make('first'), make('second')]);
    expect(outcomes.sort()).toEqual(['ISSUES_LIMIT', 'made']);
    const held = await cloned.db
      .selectFrom('issues')
      .select('id')
      .where('workspace_id', '=', workspace.id)
      .execute();
    expect(held).toHaveLength(ISSUES_PER_WORKSPACE_MAX);
  }, 60_000);
});
