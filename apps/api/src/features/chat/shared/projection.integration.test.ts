/** Historical indexing must recover without pretending that an old message was edited today. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { backfillSharedLinks } from './projection';
import { sharedIn } from './shared';
import { tombstoneRows } from '../messages/tombstone';
import { reviseMessage } from '../messages/edit';
import { fixedClock } from '../../../platform/clock';
import { attempt } from '../../../testing/attempt';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const NOW = new Date('2026-11-11T12:00:00Z');

describe('integration: Shared historical projection', () => {
  test('a previous writer edit is captured after the historical pass has completed', async () => {
    await withRollback(async (db) => {
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
          content: 'http://intranet/old',
        })
        .execute();
      await backfillSharedLinks(db, 100);
      const context = await requireWorkspaceMembership(db, ada.userId, room.workspaceId);
      expect((await sharedIn(db, context, { view: 'links' })).indexing).toBe(false);
      // This bypasses the new application helper, as a previous node during a rolling upgrade does.
      await db
        .updateTable('messages')
        .set({ content: 'http://intranet/current' })
        .where('id', '=', id)
        .execute();
      expect((await sharedIn(db, context, { view: 'links' })).indexing).toBe(true);
      expect((await sharedIn(db, context, { view: 'links' })).data).toEqual([]);
      expect(await backfillSharedLinks(db, 1)).toBe(1);
      const page = await sharedIn(db, context, { view: 'links' });
      expect(page.indexing).toBe(false);
      expect(page.data.map((item) => (item.kind === 'link' ? item.link.url : ''))).toEqual([
        'http://intranet/current',
      ]);
    }, cloned.db);
  });
  test('integration: Shared backfill resumes a partial historical batch and excludes deleted/system bodies', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada']);
      const ada = room.members['ada'];
      if (ada === undefined) throw new Error('no writer');
      for (const kind of ['text', 'incoming', 'github', 'deleted'] as const)
        await db
          .insertInto('messages')
          .values({
            id: messageId(NOW),
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: kind === 'incoming' || kind === 'github' ? null : ada.userId,
            message_type: kind === 'incoming' || kind === 'github' ? 'system_event' : 'text',
            metadata:
              kind === 'incoming'
                ? { kind: 'incoming_webhook', name: 'ERP' }
                : kind === 'github'
                  ? { kind: 'push' }
                  : {},
            content: `http://intranet/${kind}`,
            deleted_at: kind === 'deleted' ? NOW : null,
          })
          .execute();
      // Historical rows predate the capture trigger; no queued source id exists yet.
      await db
        .deleteFrom('message_shared_jobs')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(await backfillSharedLinks(db, 2)).toBe(2);
      expect(
        (
          await db
            .selectFrom('shared_link_backfill')
            .select('complete')
            .where('name', '=', 'links')
            .executeTakeFirstOrThrow()
        ).complete,
      ).toBe(false);
      expect(await backfillSharedLinks(db, 2)).toBe(2);
      expect(await backfillSharedLinks(db, 2)).toBe(0);
      expect(
        (
          await db
            .selectFrom('message_shared_links')
            .where('workspace_id', '=', room.workspaceId)
            .select('url')
            .orderBy('url')
            .execute()
        ).map((row) => row.url),
      ).toEqual(['http://intranet/incoming', 'http://intranet/text']);
      for (const batch of [0, 101, 1.5])
        expect(await attempt(db, () => backfillSharedLinks(db, batch))).toBe(
          'Error: Invalid Shared backfill batch',
        );
    }, cloned.db);
  });

  test('integration: historical link backfill preserves source version, timestamps and conversation replay ordering', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada']);
      const ada = room.members['ada'];
      if (ada === undefined) throw new Error('no writer');
      await db
        .insertInto('messages')
        .values({
          id: messageId(NOW),
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: ada.userId,
          content: '[Policy](http://intranet/policy)',
          created_at: NOW,
          updated_at: NOW,
          changed_at: NOW,
        })
        .execute();
      await db
        .deleteFrom('message_shared_jobs')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      const context = await requireWorkspaceMembership(db, ada.userId, room.workspaceId);
      expect((await sharedIn(db, context, { view: 'links' })).indexing).toBe(true);
      const before = await db
        .selectFrom('messages')
        .where('workspace_id', '=', room.workspaceId)
        .select(['changed_at', 'updated_at', 'created_at', 'state_version'])
        .executeTakeFirstOrThrow();
      expect(await backfillSharedLinks(db, 1)).toBe(1);
      const source = await db
        .selectFrom('messages')
        .where('workspace_id', '=', room.workspaceId)
        .select(['changed_at', 'updated_at', 'created_at', 'state_version'])
        .executeTakeFirstOrThrow();
      expect(source).toEqual(before);
      const page = await sharedIn(db, context, { view: 'links' });
      expect(page.indexing).toBe(false);
      expect(page.data).toHaveLength(1);
      expect(await backfillSharedLinks(db, 1)).toBe(0);
      // The bookkeeping exemption does not exempt a real content edit from conversation replay.
      await reviseMessage(
        db,
        fixedClock(new Date(NOW.getTime() + 1000)),
        ada.userId,
        page.data[0]?.messageId ?? '',
        'https://example.com/current',
      );
      const edited = await db
        .selectFrom('messages')
        .where('workspace_id', '=', room.workspaceId)
        .select('changed_at')
        .executeTakeFirstOrThrow();
      expect(edited.changed_at.getTime()).toBeGreaterThan(before.changed_at.getTime());
      await tombstoneRows(
        db,
        NOW,
        page.data.map((item) => item.messageId),
      );
      expect(
        await db
          .selectFrom('message_shared_links')
          .where('workspace_id', '=', room.workspaceId)
          .select('url')
          .execute(),
      ).toEqual([]);
      expect((await sharedIn(db, context, { view: 'links' })).data).toEqual([]);
    }, cloned.db);
  });
});
