/**
 * Applying the writes of an edition file on a real database (D-292): all of them in one transaction, or only finding out what they
 * would change, and again is the same. The command that reads the file is held as a process by `cli/entitlements-apply.integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  closeIntegrationDatabase,
  DROP_HOOK_MS,
  withRollback,
  type DatabasePool,
  type Executor,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { NOW } from '../../testing/doubles';
import { aUniqueSlug } from '../../testing/users';
import type { EntitlementCatalogue, EntitlementWrite } from './apply';
import { applyEdition } from './edition';

let clone: Awaited<ReturnType<typeof cloneIntegrationDatabase>> | undefined;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone?.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** A database with its own connections, which a transaction can really be undone on (a rolled-back test transaction cannot show it). */
const pool = (): DatabasePool => {
  if (clone === undefined) throw new Error('the private database was not created');
  return clone.db;
};

const clock = fixedClock(NOW);
const catalogue: EntitlementCatalogue = {
  mode: 'managed',
  carried: [
    { id: 'base', requires: [] },
    { id: 'extra', requires: ['base'] },
  ],
};

const aWorkspace = async (db: Executor): Promise<string> =>
  (
    await db
      .insertInto('workspaces')
      .values({ name: 'Edition', slug: aUniqueSlug('edition') })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

const rowsOf = async (db: Executor, workspaceId: string): Promise<string[]> =>
  (
    await db
      .selectFrom('workspace_modules')
      .select(['module', 'state'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('module')
      .execute()
  ).map((row) => `${row.module}:${row.state}`);

const on = (workspaceId: string, module: string): EntitlementWrite => ({
  workspaceId,
  module,
  state: 'on',
});

describe('integration: applying the writes of an edition file', () => {
  test('writes them and answers what changed, and again changes nothing', async () => {
    await withRollback(async (db) => {
      const workspaceId = await aWorkspace(db);
      const writes = [on(workspaceId, 'base'), on(workspaceId, 'extra')];
      const first = await applyEdition(db, clock, catalogue, 'file:editions.json', writes, false);
      expect(first.map(({ module }) => module)).toEqual(['base', 'extra']);
      expect(await rowsOf(db, workspaceId)).toEqual(['base:on', 'extra:on']);
      expect(await applyEdition(db, clock, catalogue, 'file:editions.json', writes, false)).toEqual(
        [],
      );
    });
  });

  test('a dry run says the same and leaves nothing behind, the trail included', async () => {
    const workspaceId = await aWorkspace(pool());
    const said = await applyEdition(
      pool(),
      clock,
      catalogue,
      'file:editions.json',
      [on(workspaceId, 'base')],
      true,
    );
    expect(said).toHaveLength(1);
    expect(await rowsOf(pool(), workspaceId)).toEqual([]);
    const trail = await pool()
      .selectFrom('server_audit_log')
      .select('id')
      .where('target_workspace_id', '=', workspaceId)
      .execute();
    expect(trail).toEqual([]);
  });

  test('a refusal for one workspace is the real run’s too, and nothing of the batch is written for the others', async () => {
    const fine = await aWorkspace(pool());
    const lacking = await aWorkspace(pool());
    const writes = [on(fine, 'base'), on(lacking, 'extra')];
    for (const dryRun of [true, false]) {
      let refused: unknown;
      try {
        await applyEdition(pool(), clock, catalogue, 'file:editions.json', writes, dryRun);
      } catch (error) {
        refused = error;
      }
      expect((refused as { body?: { code?: string } }).body?.code).toBe('MODULE_REQUIRES');
    }
    expect(await rowsOf(pool(), fine)).toEqual([]);
    expect(await rowsOf(pool(), lacking)).toEqual([]);
  });
});
