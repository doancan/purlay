import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireMessageById } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom } from '../../testing/rooms';
import { searchIn } from '../search/search';
import { setReminder } from '../reminders/reminders';
import { saveMessage, savedIds } from '../saved/saved';
import { hideMessage } from './hide';
import { messageHistory, messageWindow, sendMessage } from './messages';
import { threadReplies } from './threads';
import { changesIn } from './changes';
import { removeMessage } from './delete';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const clock = fixedClock(new Date('2026-10-28T12:00:00Z'));

describe('integration: delete for me', () => {
  test('hiding is private and idempotent, does not grant global deletion, and survives history/search/replay reads', async () => {
    await withRollback(async (tx) => {
      const room = await aRoom(tx, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('missing people');
      const sent = await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Personal deletion evidence',
      });
      const before = await changesIn(tx, bob.context, {});
      const hidden = await hideMessage(tx, clock, bob.userId, sent.message.id);
      expect(hidden.message.hiddenForMe).toBe(true);
      expect(hidden.message.content).toBe('');
      expect((await hideMessage(tx, clock, bob.userId, sent.message.id)).at).toBe(hidden.at);
      expect((await messageHistory(tx, bob.context)).data).toEqual([]);
      expect((await messageHistory(tx, alice.context)).data[0]?.content).toBe(
        'Personal deletion evidence',
      );
      const bobWorkspace = await requireWorkspaceMembership(tx, bob.userId, room.workspaceId);
      expect((await searchIn(tx, bobWorkspace, [room.channelId], { q: 'evidence' })).data).toEqual(
        [],
      );
      expect(
        (
          await searchIn(
            tx,
            await requireWorkspaceMembership(tx, alice.userId, room.workspaceId),
            [room.channelId],
            { q: 'evidence' },
          )
        ).data,
      ).toHaveLength(1);
      const replay = await changesIn(tx, bob.context, { since: before.asOf });
      expect(replay.data.find((message) => message.id === sent.message.id)?.hiddenForMe).toBe(true);
      const around = await messageWindow(
        tx,
        await requireMessageById(tx, bob.userId, sent.message.id),
      );
      expect(around.target.content).toBe('');
      expect(around.target.hiddenForMe).toBe(true);
      let refusal: unknown;
      try {
        await removeMessage(tx, clock, bob.userId, sent.message.id);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ body: { code: 'FORBIDDEN' } });
      expect(
        await tx
          .selectFrom('messages')
          .select(['content', 'deleted_at'])
          .where('id', '=', sent.message.id)
          .executeTakeFirst(),
      ).toEqual({ content: 'Personal deletion evidence', deleted_at: null });
    });
  });

  test('only the hiding person’s counts, saves and reminders change, including a later global deletion', async () => {
    await withRollback(async (tx) => {
      const room = await aRoom(tx, ['alice', 'bob', 'carol']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      const carol = room.members['carol'];
      if (alice === undefined || bob === undefined || carol === undefined)
        throw new Error('missing people');
      const sent = await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: `Hello @${bob.username}`,
      });
      await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Still unread',
      });
      for (const user of [bob.userId, carol.userId]) {
        await saveMessage(tx, clock, user, sent.message.id, {});
        await setReminder(tx, clock, user, sent.message.id, '2026-10-28T13:00:00Z');
      }
      await hideMessage(tx, clock, bob.userId, sent.message.id);
      const counts = async (user: string): Promise<number> =>
        (
          await tx
            .selectFrom('channel_members')
            .select('unread_count')
            .where('channel_id', '=', room.channelId)
            .where('user_id', '=', user)
            .executeTakeFirstOrThrow()
        ).unread_count;
      expect(await counts(bob.userId)).toBe(1);
      expect(await counts(carol.userId)).toBe(2);
      expect(
        await savedIds(tx, await requireWorkspaceMembership(tx, bob.userId, room.workspaceId)),
      ).toEqual([]);
      expect(
        await savedIds(tx, await requireWorkspaceMembership(tx, carol.userId, room.workspaceId)),
      ).toHaveLength(1);
      expect(
        await tx
          .selectFrom('message_reminders')
          .select('user_id')
          .where('message_id', '=', sent.message.id)
          .execute(),
      ).toEqual([{ user_id: carol.userId }]);
      await removeMessage(tx, clock, alice.userId, sent.message.id);
      expect(await counts(bob.userId)).toBe(1);
      expect(await counts(carol.userId)).toBe(1);
    });
  });

  test('a hidden root preserves its replies and a hidden reply is a private tombstone', async () => {
    await withRollback(async (tx) => {
      const room = await aRoom(tx, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('missing people');
      const root = await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Root words',
      });
      const reply = await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Reply words',
        parentId: root.message.id,
      });
      await hideMessage(tx, clock, bob.userId, root.message.id);
      const history = await messageHistory(tx, bob.context);
      expect(history.data[0]?.hiddenForMe).toBe(true);
      expect(history.data[0]?.thread?.replyCount).toBe(1);
      const visible = await requireMessageById(tx, bob.userId, root.message.id);
      expect((await threadReplies(tx, visible)).data[0]?.content).toBe('Reply words');
      await hideMessage(tx, clock, bob.userId, reply.message.id);
      expect((await threadReplies(tx, visible)).data[0]?.content).toBe('');
      expect(
        (await threadReplies(tx, await requireMessageById(tx, alice.userId, root.message.id)))
          .data[0]?.content,
      ).toBe('Reply words');
    });
  });
});
