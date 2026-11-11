/** Shared filters and both item kinds obey the current source authority, including strict guest history. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom, type Room } from '../../../testing/rooms';
import { linkFile } from '../../../testing/sent-files';
import { attempt } from '../../../testing/attempt';
import { sendMessage } from '../messages/messages';
import { sharedIn } from './shared';

afterAll(closeIntegrationDatabase);
const NOW = new Date('2026-11-11T12:00:00Z');
const clock = fixedClock(NOW);

const attach = async (
  db: Executor,
  room: Room,
  message: string,
  filename = 'Report.pdf',
  mime = 'application/pdf',
): Promise<string> => {
  const user = room.members['ada'];
  if (user === undefined) throw new Error('no writer');
  const id = messageId(NOW);
  await db
    .insertInto('attachments')
    .values({
      id,
      workspace_id: room.workspaceId,
      uploader_id: user.userId,
      storage_key: `w/${room.workspaceId}/${id}`,
      file_name: filename,
      mime_type: mime,
      size_bytes: '1',
    })
    .execute();
  await linkFile(db, {
    id,
    workspaceId: room.workspaceId,
    channelId: room.channelId,
    messageId: message,
  });
  return id;
};

describe('integration: Shared files and links current authority', () => {
  for (const change of [
    'hidden',
    'deleted',
    'private membership',
    'workspace membership',
    'archived',
    'workspace deleted',
  ] as const) {
    test(`neither item kind survives ${change}, even with a previously minted workspace context`, async () => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['ada', 'bob'], { type: 'private' });
        const ada = room.members['ada'];
        const bob = room.members['bob'];
        if (ada === undefined || bob === undefined) throw new Error('incomplete room');
        const id = messageId(NOW);
        await sendMessage(db, clock, ada.context, { id, content: 'https://example.com/policy' });
        await attach(db, room, id);
        const context = await requireWorkspaceMembership(db, bob.userId, room.workspaceId);
        expect((await sharedIn(db, context, { view: 'files' })).data).toHaveLength(1);
        expect((await sharedIn(db, context, { view: 'links' })).data).toHaveLength(1);
        if (change === 'hidden')
          await db
            .insertInto('hidden_messages')
            .values({
              user_id: bob.userId,
              message_id: id,
              workspace_id: room.workspaceId,
              channel_id: room.channelId,
              hidden_at: NOW,
            })
            .execute();
        if (change === 'deleted')
          await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', id).execute();
        if (change === 'private membership')
          await db
            .deleteFrom('channel_members')
            .where('channel_id', '=', room.channelId)
            .where('user_id', '=', bob.userId)
            .execute();
        if (change === 'workspace membership')
          await db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', room.workspaceId)
            .where('user_id', '=', bob.userId)
            .execute();
        if (change === 'archived')
          await db
            .updateTable('channels')
            .set({ deleted_at: NOW })
            .where('id', '=', room.channelId)
            .execute();
        if (change === 'workspace deleted')
          await db
            .updateTable('workspaces')
            .set({ deleted_at: NOW })
            .where('id', '=', room.workspaceId)
            .execute();
        for (const view of ['files', 'links'] as const)
          expect(await sharedIn(db, context, { view, limit: 1 })).toEqual({
            data: [],
            nextCursor: null,
            indexing: false,
          });
      });
    });
  }

  test('unindexed private history does not disclose itself through indexing status or a channel filter', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada'], { type: 'private', outsiders: ['bob'] });
      const ada = room.members['ada'];
      const bob = room.outsiders['bob'];
      if (ada === undefined || bob === undefined) throw new Error('incomplete room');
      await db
        .insertInto('messages')
        .values({
          id: messageId(NOW),
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: ada.userId,
          content: 'https://secret.example/private',
        })
        .execute();
      const context = await requireWorkspaceMembership(db, bob.userId, room.workspaceId);
      expect(await sharedIn(db, context, { view: 'links' })).toEqual({
        data: [],
        nextCursor: null,
        indexing: false,
      });
      expect(
        await attempt(db, () =>
          sharedIn(db, context, { view: 'links', channelId: room.channelId }),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
    });
  });

  test('a guest sees only post-join files and links, and an expired guest sees neither', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'guest']);
      const ada = room.members['ada'];
      const guest = room.members['guest'];
      if (ada === undefined || guest === undefined) throw new Error('incomplete room');
      const since = new Date(Date.now() - 60_000);
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: since,
          guest_expires_at: null,
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', guest.userId)
        .execute();
      const ids: string[] = [];
      for (const delta of [-1_000, 1_000]) {
        const at = new Date(since.getTime() + delta),
          id = messageId(at);
        ids.push(id);
        await sendMessage(db, fixedClock(at), ada.context, {
          id,
          content: `https://example.com/${String(delta)}`,
        });
        await attach(db, room, id);
      }
      const context = await requireWorkspaceMembership(db, guest.userId, room.workspaceId);
      for (const view of ['files', 'links'] as const)
        expect(
          (await sharedIn(db, context, { view, limit: 1 })).data.map((row) => row.messageId),
        ).toEqual([ids[1]!]);
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(Date.now() - 1) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', guest.userId)
        .execute();
      for (const view of ['files', 'links'] as const)
        expect(await sharedIn(db, context, { view })).toEqual({
          data: [],
          nextCursor: null,
          indexing: false,
        });
    });
  });

  test('files use a compound cursor within a multi-file message and intersect type, name, person and dates', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const ada = room.members['ada'];
      const bob = room.members['bob'];
      if (ada === undefined || bob === undefined) throw new Error('incomplete room');
      const id = messageId(NOW);
      await sendMessage(db, clock, ada.context, { id, content: 'A shared report' });
      const files = [
        await attach(db, room, id, 'budget_100%.pdf'),
        await attach(db, room, id, 'Report.pdf'),
        await attach(db, room, id, 'Policy.txt', 'text/plain'),
      ];
      const context = await requireWorkspaceMembership(db, bob.userId, room.workspaceId);
      const seen: string[] = [];
      let before: string | undefined;
      do {
        const page = await sharedIn(db, context, {
          view: 'files',
          limit: 1,
          ...(before === undefined ? {} : { before }),
        });
        for (const row of page.data) if (row.kind === 'file') seen.push(row.attachment.id);
        before = page.nextCursor ?? undefined;
      } while (before !== undefined);
      expect(new Set(seen).size).toBe(3);
      expect(new Set(seen)).toEqual(new Set(files));
      const pdfs = await sharedIn(db, context, {
        view: 'files',
        type: 'pdf',
        channelId: room.channelId,
        senderId: ada.userId,
        since: NOW.toISOString(),
        until: new Date(NOW.getTime() + 1).toISOString(),
      });
      expect(pdfs.data).toHaveLength(2);
      expect((await sharedIn(db, context, { view: 'files', type: 'other' })).data).toHaveLength(1);
      expect((await sharedIn(db, context, { view: 'files', q: '100%' })).data).toHaveLength(1);
      expect((await sharedIn(db, context, { view: 'files', q: '_' })).data).toHaveLength(1);
      expect((await sharedIn(db, context, { view: 'files', senderId: bob.userId })).data).toEqual(
        [],
      );
      expect(
        (await sharedIn(db, context, { view: 'files', until: NOW.toISOString() })).data,
      ).toEqual([]);
    });
  });

  test('cursor scope and field errors do not become an alternate source read', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const ada = room.members['ada'];
      const bob = room.members['bob'];
      if (ada === undefined || bob === undefined) throw new Error('incomplete room');
      await sendMessage(db, clock, ada.context, {
        id: messageId(NOW),
        content: 'https://example.com/a https://example.com/b',
      });
      const context = await requireWorkspaceMembership(db, bob.userId, room.workspaceId),
        first = await sharedIn(db, context, { view: 'links', limit: 1 });
      if (first.nextCursor === null) throw new Error('no cursor');
      for (const query of [
        { view: 'links' as const, q: 'changed', before: first.nextCursor },
        { view: 'files' as const, before: first.nextCursor },
        { view: 'links' as const, before: 'garbage' },
        { view: 'links' as const, type: 'pdf' as const },
        { view: 'links' as const, since: NOW.toISOString(), until: NOW.toISOString() },
        { view: 'links' as const, since: '2026-99-99T00:00:00Z' },
        { view: 'links' as const, since: '2026-11-11T12:00:00+99:00' },
        { view: 'files' as const, until: '2026-02-31T00:00:00Z' },
      ])
        expect(await attempt(db, () => sharedIn(db, context, query))).toBe('VALIDATION_FAILED');
    });
  });
});
