/** A historical worker never queues behind a writer and cannot overwrite the writer's projection. */
import { afterAll, describe, beforeAll, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { aRoom } from '../../../testing/rooms';
import { reviseMessage } from '../messages/edit';
import { backfillSharedLinks } from './projection';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { sharedIn } from './shared';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const NOW = new Date('2026-11-11T12:00:00Z');

describe('integration: Shared source concurrency', () => {
  test('completion after a page snapshot still reports pending coverage instead of stranding an empty list', async () => {
    const local = await cloneIntegrationDatabase();
    try {
      const room = await aRoom(local.db, ['ada']);
      const ada = room.members['ada'];
      if (ada === undefined) throw new Error('no writer');
      const id = messageId(NOW);
      await local.db
        .insertInto('messages')
        .values({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: ada.userId,
          content: 'http://intranet/historical',
        })
        .execute();
      const context = await requireWorkspaceMembership(local.db, ada.userId, room.workspaceId);
      let completed = false;
      const instrumented = local.db.withPlugin({
        transformQuery: (args): typeof args.node => args.node,
        transformResult: async (args): Promise<typeof args.result> => {
          if (!completed) {
            completed = true;
            await local.withFreshPool(async (fresh) => {
              await backfillSharedLinks(fresh, 100);
            });
          }
          return args.result;
        },
      });
      const snapshot = await sharedIn(instrumented, context, { view: 'links' });
      expect(completed).toBe(true);
      expect(snapshot.data.length > 0 || snapshot.indexing).toBe(true);
      const current = await sharedIn(local.db, context, { view: 'links' });
      expect(current.indexing).toBe(false);
      expect(current.data).toHaveLength(1);
    } finally {
      await local.drop();
    }
  });
  test('a historical source held for deletion never advances an unqueued interval; it is retried after release', async () => {
    const local = await cloneIntegrationDatabase();
    try {
      const room = await aRoom(local.db, ['ada']);
      const ada = room.members['ada'];
      if (ada === undefined) throw new Error('no writer');
      const id = messageId(NOW);
      await local.db
        .insertInto('messages')
        .values({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: ada.userId,
          content: 'http://intranet/retained',
        })
        .execute();
      await local.db.deleteFrom('message_shared_jobs').where('message_id', '=', id).execute();
      const locked = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const holder = local.db.transaction().execute(async (tx) => {
        await tx.selectFrom('messages').select('id').where('id', '=', id).forUpdate().execute();
        locked.resolve(undefined);
        await release.promise;
      });
      try {
        await locked.promise;
        expect(
          await local.withFreshPool(async (fresh) => await backfillSharedLinks(fresh, 1)),
        ).toBe(0);
        expect(
          await local.db
            .selectFrom('shared_link_backfill')
            .select(['before_message_id', 'complete'])
            .where('name', '=', 'links')
            .executeTakeFirstOrThrow(),
        ).toEqual({ before_message_id: null, complete: false });
      } finally {
        release.resolve(undefined);
        await holder;
      }
      expect(await backfillSharedLinks(local.db, 1)).toBe(1);
      expect(
        await local.db
          .selectFrom('message_shared_links')
          .select('url')
          .where('message_id', '=', id)
          .execute(),
      ).toEqual([{ url: 'http://intranet/retained' }]);
    } finally {
      await local.drop();
    }
  });
  test('integration: Shared backfill skips an in-flight edit and a restarted batch keeps only the committed new links', async () => {
    const { db } = cloned;
    const room = await aRoom(db, ['ada']);
    const ada = room.members['ada'];
    if (ada === undefined) throw new Error('no writer');
    const id = messageId(NOW);
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        sender_id: ada.userId,
        content: 'http://intranet/obsolete',
      })
      .execute();
    await db.deleteFrom('message_shared_jobs').where('message_id', '=', id).execute();
    const locked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const edit = db.transaction().execute(async (tx) => {
      await tx.selectFrom('messages').where('id', '=', id).select('id').forNoKeyUpdate().execute();
      locked.resolve(undefined);
      await release.promise;
      await reviseMessage(tx, fixedClock(NOW), ada.userId, id, 'http://intranet/current');
    });
    try {
      await locked.promise;
      const skipped = await cloned.withFreshPool(
        async (fresh) => await backfillSharedLinks(fresh, 1),
      );
      expect(skipped).toBe(0);
    } finally {
      release.resolve(undefined);
      await edit;
    }
    expect(await cloned.withFreshPool(async (fresh) => await backfillSharedLinks(fresh, 1))).toBe(
      0,
    );
    expect(
      await db
        .selectFrom('message_shared_links')
        .select('url')
        .where('message_id', '=', id)
        .execute(),
    ).toEqual([{ url: 'http://intranet/current' }]);
  });
});
