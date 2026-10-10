/**
 * What a channel says about the person asking: their read position, their counters
 * and, for a direct message, the other person (D-98, D-99).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { requireChannelById } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aChannelWith, aConversation, aMessageIn } from '../../testing/conversations';
import { channelFor, channelIn, channelsVisibleIn, createChannel, joinChannel } from './channels';
import { openDirectMessage } from './direct-messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

/**
 * The same executor, counting the statements it is asked to run. Kysely calls a
 * plugin once per executed query, so this is exact and needs no access to the
 * driver.
 */
const counting = (db: Executor): { readonly db: Executor; readonly count: () => number } => {
  let statements = 0;
  const counted = db.withPlugin({
    transformQuery: (args) => args.node,
    transformResult: (args) => {
      statements += 1;
      return Promise.resolve(args.result);
    },
  });
  return { db: counted, count: () => statements };
};

describe('integration: what a channel says about the person asking', () => {
  test('a member is told their position and counters; a person who only sees it is told none', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'cs-alice', 'cs-bob');
      const [alice, bob] = users as [(typeof users)[0], (typeof users)[0]];
      const channelId = await aChannelWith(db, workspaceId, 'general', alice);
      const last = await aMessageIn(db, { workspaceId, channelId }, bob);
      await db
        .updateTable('channel_members')
        .set({ last_read_message_id: last, unread_count: 4, unread_mention_count: 2 })
        .where('user_id', '=', alice.userId)
        .execute();

      const forAlice = await channelFor(db, alice.userId, channelId);
      expect(forAlice.state).toEqual({
        lastReadMessageId: last,
        unreadCount: 4,
        unreadMentionCount: 2,
      });
      expect(forAlice.peer).toBeNull();

      // Bob is in the workspace and the channel is public: he can see it, and has not joined.
      const forBob = await channelFor(db, bob.userId, channelId);
      expect(forBob.state).toBeNull();
    });
  });

  test('a channel that does not exist is the answer a stranger gets', async () => {
    await withRollback(async (db) => {
      const { users } = await aConversation(db, 'cs-nobody');
      const error = await channelFor(db, users[0]?.userId ?? '', crypto.randomUUID()).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toMatchObject({ body: { code: 'CHANNEL_NOT_FOUND' } });
    });
  });

  test('joining makes a membership with nothing counted and no position', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'cs-owner', 'cs-joiner');
      const [owner, joiner] = users as [(typeof users)[0], (typeof users)[0]];
      const channelId = await aChannelWith(db, workspaceId, 'open', owner);
      const context = await requireChannelById(db, joiner.userId, channelId);

      await joinChannel(db, clock, context);
      expect((await channelIn(db, context)).state).toEqual({
        lastReadMessageId: null,
        unreadCount: 0,
        unreadMentionCount: 0,
      });
    });
  });

  test('creating a channel puts the creator in it, with nothing counted', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'cs-maker');
      const context = await requireWorkspaceMembership(db, users[0]?.userId ?? '', workspaceId);
      const created = await createChannel(db, clock, context, { name: 'fresh' });
      expect(created.state).toEqual({
        lastReadMessageId: null,
        unreadCount: 0,
        unreadMentionCount: 0,
      });
      expect(created.peer).toBeNull();
    });
  });

  /**
   * The other person is the one who is not the caller; in a note to self there is
   * only the caller, and they are their own peer (D-6).
   */
  test('a direct message names the other person, to each of the two, and a note to self names you', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'cs-ann', 'cs-ben');
      const [ann, ben] = users as [(typeof users)[0], (typeof users)[0]];
      const annContext = await requireWorkspaceMembership(db, ann.userId, workspaceId);
      const benContext = await requireWorkspaceMembership(db, ben.userId, workspaceId);

      const pair = await openDirectMessage(db, clock, annContext, ben.userId);
      expect(pair.channel.peer?.id).toBe(ben.userId);
      expect(pair.channel.peer?.username).toBe(ben.username);
      expect(pair.forPeer?.peer?.id).toBe(ann.userId);
      expect((await openDirectMessage(db, clock, benContext, ann.userId)).channel.peer?.id).toBe(
        ann.userId,
      );

      const self = await openDirectMessage(db, clock, annContext, ann.userId);
      expect(self.channel.peer?.id).toBe(ann.userId);
      expect(self.channel.type).toBe('direct_message');
      expect(self.channel.name).toBeNull();
    });
  });

  test('the list is in activity order, newest first, and carries each state', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'cs-lister');
      const [lister] = users as [(typeof users)[0]];
      const context = await requireWorkspaceMembership(db, lister.userId, workspaceId);
      const quiet = await aChannelWith(db, workspaceId, 'a-quiet', lister);
      const busy = await aChannelWith(db, workspaceId, 'b-busy', lister);
      await db
        .updateTable('channels')
        .set({ last_message_at: new Date('2026-09-09T11:00:00.000Z') })
        .where('id', '=', busy)
        .execute();

      const listed = await channelsVisibleIn(db, context);
      expect(listed.map((channel) => channel.id)).toEqual([busy, quiet]);
      expect(listed.every((channel) => channel.state !== null)).toBe(true);
    });
  });

  /**
   * The sidebar renders on every load, so a query per channel is the N+1 the rules
   * forbid: the number of statements must not depend on the number of channels.
   */
  test('listing costs the same however many channels there are, direct messages included', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'cs-n1', 'cs-n1-peer');
      const [me, peer] = users as [(typeof users)[0], (typeof users)[0]];
      const context = await requireWorkspaceMembership(db, me.userId, workspaceId);

      const cost = async (): Promise<number> => {
        const meter = counting(db);
        await channelsVisibleIn(meter.db, context);
        return meter.count();
      };

      for (let n = 0; n < 5; n += 1) await aChannelWith(db, workspaceId, `few-${String(n)}`, me);
      await openDirectMessage(db, clock, context, peer.userId);
      const few = await cost();

      for (let n = 0; n < 45; n += 1) await aChannelWith(db, workspaceId, `many-${String(n)}`, me);
      const many = await cost();

      // A meter that counted nothing would pass this for the wrong reason.
      expect(few).toBeGreaterThan(0);
      expect(many).toBe(few);
      expect((await channelsVisibleIn(db, context)).length).toBe(51);
    });
  });
});
