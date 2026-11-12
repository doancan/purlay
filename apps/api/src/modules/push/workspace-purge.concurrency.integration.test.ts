/**
 * Workspace erasure must finish the push journal and yield to a subscription cascade.
 * @needs-modules chat, issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase } from '@purlay/db';
import { WORKSPACE_DELETION_GRACE_DAYS } from '@purlay/types';
import { composition } from '../../composition';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { NO_LOG } from '../../platform/events';
import { NOW } from '../../testing/doubles';
import { pendingPush } from '../../testing/pending-push';
import { aMemoryStore } from '../../testing/storage';
import { purgeWorkspaceContent } from '../workspaces/deletion-purge';

afterAll(closeIntegrationDatabase);

describe('integration: workspace push retirement', () => {
  test('a busy child leaves erasure retryable and a later run empties the journal', async () => {
    const owned = await cloneIntegrationDatabase();
    const held = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let blocking: Promise<void> | undefined;
    try {
      const world = await pendingPush(owned.db);
      await owned.db
        .updateTable('workspaces')
        .set({ deleted_at: NOW, purge_started_at: NOW })
        .where('id', '=', world.room.workspaceId)
        .execute();
      blocking = owned.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('push_deliveries')
          .select('intent_id')
          .where('subscription_id', '=', world.devices[0]!.id)
          .forUpdate()
          .execute();
        held.resolve(undefined);
        await release.promise;
      });
      await held.promise;
      const dependencies = {
        database: owned.db,
        log: NO_LOG,
        storage: aMemoryStore(),
        clock: fixedClock(new Date(NOW.getTime() + (WORKSPACE_DELETION_GRACE_DAYS + 1) * DAY_MS)),
      };
      const problem: unknown = await purgeWorkspaceContent(
        dependencies,
        world.room.workspaceId,
        composition.workspacePurge,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(problem).toBeInstanceOf(Error);
      expect(
        await owned.db
          .selectFrom('workspaces')
          .select('purged_at')
          .where('id', '=', world.room.workspaceId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ purged_at: null });
      release.resolve(undefined);
      await blocking;
      await purgeWorkspaceContent(dependencies, world.room.workspaceId, composition.workspacePurge);
      expect(
        await owned.db
          .selectFrom('push_intents')
          .select('id')
          .where('workspace_id', '=', world.room.workspaceId)
          .execute(),
      ).toEqual([]);
      expect(
        await owned.db
          .selectFrom('push_deliveries')
          .select('intent_id')
          .where('subscription_id', '=', world.devices[0]!.id)
          .execute(),
      ).toEqual([]);
    } finally {
      release.resolve(undefined);
      await blocking;
      await owned.drop();
    }
  }, 30_000);
});
