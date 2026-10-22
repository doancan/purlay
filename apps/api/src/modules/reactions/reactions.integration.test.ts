/**
 * Reacting, against a real database: what a reaction does to the set, and — as
 * much — what it does not tell the room (D-99 §6).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame, type Topic } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { NOW } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { revokeSession } from '../auth/sessions';
import { REACTION_KINDS_MAX, setReaction } from './reactions';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

/**
 * Each reaction happens a second after the last, as it does when people react. The
 * order of a set is the order they arrived in, and inside one transaction the
 * database's own timestamp is the same for all of them — so the time is the
 * module's clock, and the test moves it.
 */
let tick = 0;
const later = (): ReturnType<typeof fixedClock> => {
  tick += 1;
  return fixedClock(new Date(NOW.getTime() + tick * 1000));
};

/** A bus that remembers what it was asked to publish, and to whom. */
const aRecordingBus = (): { bus: EventBus; sent: { topic: Topic; frame: ServerFrame }[] } => {
  const sent: { topic: Topic; frame: ServerFrame }[] = [];
  const bus: EventBus = {
    publish: (topic, frame) => {
      sent.push({ topic, frame });
      return Promise.resolve();
    },
    subscribe: () => true,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, sent };
};

interface Room {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly channelId: string;
  readonly workspaceId: string;
  /** A root by Alice, a reply to it by Bob, and a root nobody can see: Alice's, deleted. */
  readonly root: string;
  readonly reply: string;
  readonly deleted: string;
}

const aRoom = async (db: Executor): Promise<Room> => {
  const alice = await aSignedInUser(db, clock, 'rx-alice');
  const bob = await aSignedInUser(db, clock, 'rx-bob');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'rx', slug: aUniqueSlug('rx') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspace.id, user_id: alice.userId, role: 'owner' },
      { workspace_id: workspace.id, user_id: bob.userId, role: 'member' },
    ])
    .execute();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Both in it: reacting is a member's (D-156).
  await db
    .insertInto('channel_members')
    .values([
      { channel_id: channel.id, user_id: alice.userId },
      { channel_id: channel.id, user_id: bob.userId },
    ])
    .execute();
  const write = async (
    sender: string,
    parentId: string | null = null,
    deleted = false,
  ): Promise<string> => {
    const id = messageId(NOW);
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: workspace.id,
        channel_id: channel.id,
        sender_id: sender,
        parent_id: parentId,
        content: 'a message',
        deleted_at: deleted ? NOW : null,
      })
      .execute();
    return id;
  };
  const root = await write(alice.userId);
  return {
    alice,
    bob,
    channelId: channel.id,
    workspaceId: workspace.id,
    root,
    reply: await write(bob.userId, root),
    deleted: await write(alice.userId, null, true),
  };
};

const react = async (
  db: Executor,
  bus: EventBus,
  who: SignedInUser,
  message: string,
  emoji: string,
  present = true,
): Promise<{ emoji: string; userIds: readonly string[] }[]> => {
  const answer = await setReaction(
    { atomically: atomicallyOn(db), clock: later(), bus },
    { userId: who.userId, sessionId: who.sessionId },
    message,
    emoji,
    present,
  );
  return answer.reactions.map((reaction) => ({ emoji: reaction.emoji, userIds: reaction.userIds }));
};

const refusalFrom = async (body: () => Promise<unknown>): Promise<AppError> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('a refusal was expected');
};

describe('integration: reacting', () => {
  test('reacting adds the caller to the emoji, and the room is told the whole set once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();

      expect(await react(db, bus, room.alice, room.root, '👍')).toEqual([
        { emoji: '👍', userIds: [room.alice.userId] },
      ]);
      expect(await react(db, bus, room.bob, room.root, '👍')).toEqual([
        { emoji: '👍', userIds: [room.alice.userId, room.bob.userId] },
      ]);

      expect(sent.map((entry) => entry.topic)).toEqual([
        `channel:${room.channelId}`,
        `channel:${room.channelId}`,
      ]);
      expect(sent[1]?.frame).toMatchObject({
        event: 'REACTIONS_UPDATED',
        data: {
          channelId: room.channelId,
          messageId: room.root,
          reactions: [{ emoji: '👍', userIds: [room.alice.userId, room.bob.userId] }],
        },
      });
    });
  });

  /** A double click must not be heard by the whole channel. */
  test('reacting twice changes nothing, answers the same set and publishes nothing the second time', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();
      const first = await react(db, bus, room.alice, room.root, '🎉');
      const second = await react(db, bus, room.alice, room.root, '🎉');
      expect(second).toEqual(first);
      expect(sent).toHaveLength(1);
    });
  });

  test('taking a reaction back removes the caller alone, and says so', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();
      await react(db, bus, room.alice, room.root, '👍');
      await react(db, bus, room.bob, room.root, '👍');
      sent.length = 0;

      expect(await react(db, bus, room.alice, room.root, '👍', false)).toEqual([
        { emoji: '👍', userIds: [room.bob.userId] },
      ]);
      expect(sent).toHaveLength(1);
      // The last voice leaving takes the emoji with it: an empty reaction is not one.
      expect(await react(db, bus, room.bob, room.root, '👍', false)).toEqual([]);
      expect(sent).toHaveLength(2);
    });
  });

  test('taking back what was never given, or what is somebody else’s, changes nothing and publishes nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();
      await react(db, bus, room.alice, room.root, '👍');
      sent.length = 0;

      // Bob never reacted: Alice's reaction is not his to take back.
      expect(await react(db, bus, room.bob, room.root, '👍', false)).toEqual([
        { emoji: '👍', userIds: [room.alice.userId] },
      ]);
      // And an emoji nobody gave.
      expect(await react(db, bus, room.bob, room.root, '🔥', false)).toEqual([
        { emoji: '👍', userIds: [room.alice.userId] },
      ]);
      expect(sent).toHaveLength(0);
    });
  });

  test('a reply can be reacted to like a root, and each message keeps its own set', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus } = aRecordingBus();
      await react(db, bus, room.alice, room.root, '👍');
      expect(await react(db, bus, room.alice, room.reply, '❤️')).toEqual([
        { emoji: '❤️', userIds: [room.alice.userId] },
      ]);
    });
  });

  test('different emoji keep the order they first arrived in, whoever adds to them later', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus } = aRecordingBus();
      await react(db, bus, room.alice, room.root, '🎉');
      await react(db, bus, room.alice, room.root, '👍');
      const set = await react(db, bus, room.bob, room.root, '🎉');
      expect(set.map((reaction) => reaction.emoji)).toEqual(['🎉', '👍']);
    });
  });
});

describe('integration: the cap on kinds', () => {
  const KINDS = Array.from({ length: REACTION_KINDS_MAX }, (_, index) =>
    String.fromCodePoint(0x1f600 + index),
  );

  test('a message carries twenty different emoji; the twenty-first is refused, naming the field', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();
      for (const emoji of KINDS) await react(db, bus, room.alice, room.root, emoji);
      sent.length = 0;

      const refusal = await refusalFrom(() => react(db, bus, room.alice, room.root, '🦄'));
      expect(refusal.status).toBe(400);
      expect(refusal.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: { emoji: expect.stringContaining('20') as string } },
      });
      expect(sent).toHaveLength(0);
    });
  });

  test('the cap is on kinds, not on people: a twenty-first person may still join a kind that is there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus } = aRecordingBus();
      for (const emoji of KINDS) await react(db, bus, room.alice, room.root, emoji);
      const set = await react(db, bus, room.bob, room.root, KINDS[0] ?? '');
      expect(set).toHaveLength(REACTION_KINDS_MAX);
      expect(set[0]?.userIds).toEqual([room.alice.userId, room.bob.userId]);
    });
  });

  test('taking a kind away makes room for another', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus } = aRecordingBus();
      for (const emoji of KINDS) await react(db, bus, room.alice, room.root, emoji);
      await react(db, bus, room.alice, room.root, KINDS[0] ?? '', false);
      expect(await react(db, bus, room.alice, room.root, '🦄')).toHaveLength(REACTION_KINDS_MAX);
    });
  });

  test('another message has its own twenty', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus } = aRecordingBus();
      for (const emoji of KINDS) await react(db, bus, room.alice, room.root, emoji);
      expect(await react(db, bus, room.alice, room.reply, '🦄')).toHaveLength(1);
    });
  });
});

describe('integration: who may react to what', () => {
  test('somebody who can see a public channel and is not in it cannot react, and may still take their own back (D-156)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();
      await react(db, bus, room.bob, room.root, '👍');
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', room.bob.userId)
        .execute();
      sent.length = 0;

      const refused = await refusalFrom(() => react(db, bus, room.bob, room.root, '🎉'));
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('NOT_A_CHANNEL_MEMBER');
      expect(sent).toHaveLength(0);

      // Taking back what they gave while they were in it is not writing: it stays theirs to do.
      expect(await react(db, bus, room.bob, room.root, '👍', false)).toEqual([]);
    });
  });

  test('a deleted message cannot be reacted to, and is the same refusal as one that never existed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();
      const gone = await refusalFrom(() => react(db, bus, room.alice, room.deleted, '👍'));
      const never = await refusalFrom(() => react(db, bus, room.alice, messageId(NOW), '👍'));
      expect(gone.status).toBe(404);
      expect(gone.body).toEqual(never.body);
      expect(gone.body.code).toBe('MESSAGE_NOT_FOUND');
      expect(sent).toHaveLength(0);
    });
  });

  test('a message in a private channel is not reachable by a workspace member outside it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const secret = await db
        .insertInto('channels')
        .values({ workspace_id: room.workspaceId, name: 'secret', type: 'private' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({ channel_id: secret.id, user_id: room.alice.userId })
        .execute();
      const hidden = messageId(NOW);
      await db
        .insertInto('messages')
        .values({
          id: hidden,
          workspace_id: room.workspaceId,
          channel_id: secret.id,
          sender_id: room.alice.userId,
          content: 'closed door',
        })
        .execute();
      const { bus, sent } = aRecordingBus();

      expect(await react(db, bus, room.alice, hidden, '👍')).toHaveLength(1);
      const refusal = await refusalFrom(() => react(db, bus, room.bob, hidden, '👍'));
      expect(refusal.body.code).toBe('MESSAGE_NOT_FOUND');
      // Only the member's reaction was heard, and on the private channel's topic.
      expect(sent.map((entry) => entry.topic)).toEqual([`channel:${secret.id}`]);
    });
  });

  test('a session that has ended reacts to nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const { bus, sent } = aRecordingBus();
      await revokeSession(db, room.alice.sessionId);
      const refusal = await refusalFrom(() => react(db, bus, room.alice, room.root, '👍'));
      expect(refusal.body.code).toBe('UNAUTHENTICATED');
      expect(sent).toHaveLength(0);
    });
  });
});
