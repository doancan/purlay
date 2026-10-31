/**
 * The reaction endpoints, through real requests.
 *
 * The emoji arrives as a percent-encoded path segment, which is where this goes
 * wrong in ways the module cannot see: an encoding that decodes to something that is
 * not one emoji, a segment too long, a sequence the decoder refuses. Each is a `400`
 * naming the field, never a `500` and never text stored in the column.
 *
 * The race has a database of its own, cloned from the template, because inside the
 * harness's one transaction there is no second request to race (D-46, D-77).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
} from '@purlay/db';
import { messageId, ReactionsResponse } from '@purlay/types';
import { REACTION_KINDS_MAX } from '../../modules/reactions/reactions';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: 'PUT' | 'DELETE',
  path: string,
  cookie?: string,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

const reactionPath = (message: string, emoji: string): string =>
  `/api/messages/${message}/reactions/${encodeURIComponent(emoji)}`;

interface Room {
  readonly owner: SignedInUser;
  readonly root: string;
  readonly deleted: string;
}

/** One workspace, one channel the owner is in, a message in it and a tombstone beside it. */
const aRoom = async (db: Executor, owner: SignedInUser): Promise<Room> => {
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'rx-http', slug: aUniqueSlug('rx-http') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: owner.userId, role: 'owner' })
    .execute();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  // In it: reacting is a member's (D-156).
  await db
    .insertInto('channel_members')
    .values({ channel_id: channel.id, user_id: owner.userId })
    .execute();
  const write = async (deleted: boolean): Promise<string> => {
    const id = messageId(NOW);
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: workspace.id,
        channel_id: channel.id,
        sender_id: owner.userId,
        content: 'a message',
        deleted_at: deleted ? NOW : null,
      })
      .execute();
    return id;
  };
  return { owner, root: await write(false), deleted: await write(true) };
};

/** Somebody brought into the workspace and the channel of this message: a reacting member (D-156). */
const aMemberOf = async (db: Executor, message: string, userId: string): Promise<void> => {
  const { workspace_id: workspaceId, channel_id: channelId } = await db
    .selectFrom('messages')
    .select(['workspace_id', 'channel_id'])
    .where('id', '=', message)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: userId, role: 'member' })
    .execute();
  await db
    .insertInto('channel_members')
    .values({ channel_id: channelId, user_id: userId })
    .execute();
};

const errorOf = async (response: Response): Promise<{ code: string; fields?: unknown }> => {
  const body = (await response.json()) as {
    error: { code: string; details?: { fields?: unknown } };
  };
  return { code: body.error.code, fields: body.error.details?.fields };
};

describe('integration: reacting over HTTP', () => {
  test('PUT answers the whole set in the contract’s shape, and DELETE takes it back', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-a'));
      const put = await call(db, 'PUT', reactionPath(room.root, '👍'), room.owner.cookie);
      expect(put.status).toBe(200);
      const set: unknown = await put.json();
      expect(Value.Check(ReactionsResponse, set)).toBe(true);
      expect(set).toEqual({ reactions: [{ emoji: '👍', userIds: [room.owner.userId] }] });

      const removed = await call(db, 'DELETE', reactionPath(room.root, '👍'), room.owner.cookie);
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ reactions: [] });
    });
  });

  test('doing either twice is a 200 both times', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-b'));
      for (const method of ['PUT', 'PUT', 'DELETE', 'DELETE'] as const) {
        const response = await call(db, method, reactionPath(room.root, '🎉'), room.owner.cookie);
        expect({ method, status: response.status }).toEqual({ method, status: 200 });
      }
    });
  });

  test.each([
    ['a ZWJ sequence', '👨‍👩‍👧'],
    ['a skin tone', '👍🏽'],
    ['a flag', '🇹🇷'],
    ['a keycap', '1️⃣'],
    ['a pictograph with a variation selector', '❤️'],
  ])('%s is one emoji', async (_name, emoji) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-c'));
      const response = await call(db, 'PUT', reactionPath(room.root, emoji), room.owner.cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        reactions: [{ emoji, userIds: [room.owner.userId] }],
      });
    });
  });

  test.each([
    ['a letter', 'a'],
    ['text', 'thumbs-up'],
    ['markup', '<script>'],
    ['two emoji', '👍👍'],
    ['an emoji and a space', '👍 '],
    ['a skin tone on its own', '🏽'],
    ['a digit on its own', '1'],
    ['thirty-three characters', '👍'.repeat(17)],
  ])('%s is refused naming the emoji, and nothing is stored', async (_name, emoji) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-d'));
      const response = await call(db, 'PUT', reactionPath(room.root, emoji), room.owner.cookie);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: { emoji: expect.any(String) as string },
      });
      const stored = await db
        .selectFrom('reactions')
        .select('id')
        .where('message_id', '=', room.root)
        .execute();
      expect(stored).toEqual([]);
    });
  });

  /**
   * Decoded once by the framework, so a double-encoded emoji reaches the format
   * check as the literal text `%F0%9F…` — which is not one.
   */
  test('a double-encoded emoji is text, and is refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-e'));
      const response = await call(
        db,
        'PUT',
        `/api/messages/${room.root}/reactions/%25F0%259F%2591%258D`,
        room.owner.cookie,
      );
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('VALIDATION_FAILED');
    });
  });

  test('a sequence the decoder refuses is a 400, never a 500', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-f'));
      const response = await call(
        db,
        'PUT',
        `/api/messages/${room.root}/reactions/%E0%A4%A`,
        room.owner.cookie,
      );
      expect(response.status).toBeLessThan(500);
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  test('no emoji at all is not a route', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-g'));
      const response = await call(
        db,
        'PUT',
        `/api/messages/${room.root}/reactions/`,
        room.owner.cookie,
      );
      expect(response.status).toBe(404);
    });
  });

  test('without a session it is 401, whichever the verb', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-h'));
      for (const method of ['PUT', 'DELETE'] as const) {
        const response = await call(db, method, reactionPath(room.root, '👍'));
        expect({ method, status: response.status }).toEqual({ method, status: 401 });
        expect((await errorOf(response)).code).toBe('UNAUTHENTICATED');
      }
    });
  });

  test('a deleted message, and a message that never was, are the same 404', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-i'));
      const gone = await call(db, 'PUT', reactionPath(room.deleted, '👍'), room.owner.cookie);
      const never = await call(db, 'PUT', reactionPath(messageId(NOW), '👍'), room.owner.cookie);
      expect(gone.status).toBe(404);
      const refusal = await errorOf(gone);
      expect(refusal).toEqual(await errorOf(never));
      expect(refusal.code).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test('the twenty-first kind is a 400; joining a kind that is there is not', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, await aSignedInUser(db, clock, 'rxh-j'));
      const kinds = Array.from({ length: REACTION_KINDS_MAX }, (_, index) =>
        String.fromCodePoint(0x1f600 + index),
      );
      for (const emoji of kinds) {
        expect(
          (await call(db, 'PUT', reactionPath(room.root, emoji), room.owner.cookie)).status,
        ).toBe(200);
      }
      const over = await call(db, 'PUT', reactionPath(room.root, '🦄'), room.owner.cookie);
      expect(over.status).toBe(400);
      expect((await errorOf(over)).fields).toMatchObject({ emoji: expect.any(String) as string });

      const bob = await aSignedInUser(db, clock, 'rxh-j2');
      await aMemberOf(db, room.root, bob.userId);
      const joined = await call(db, 'PUT', reactionPath(room.root, kinds[0] ?? ''), bob.cookie);
      expect(joined.status).toBe(200);
    });
  });
});

describe('integration: two people adding a new kind at the limit', () => {
  let cloned: ClonedDatabase;

  beforeAll(async () => {
    cloned = await cloneIntegrationDatabase();
    await sql`
      create function hold_window() returns trigger language plpgsql as
      $$ begin perform pg_sleep(0.3); return new; end $$
    `.execute(cloned.db);
  }, CLONE_HOOK_MS);

  afterAll(async () => {
    await cloned.drop();
  });

  /**
   * Both count nineteen kinds and both insert, unless something makes the second
   * wait: the trigger holds each insert open after its count, so without the lock
   * both pass the count before either commits and the message ends with twenty-one.
   */
  test('exactly one wins, and the message ends with twenty kinds', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'rxh-race-a');
    const bob = await aSignedInUser(cloned.db, clock, 'rxh-race-b');
    const room = await aRoom(cloned.db, alice);
    await aMemberOf(cloned.db, room.root, bob.userId);
    for (let index = 0; index < REACTION_KINDS_MAX - 1; index += 1) {
      await call(
        cloned.db,
        'PUT',
        reactionPath(room.root, String.fromCodePoint(0x1f600 + index)),
        alice.cookie,
      );
    }
    await sql`create trigger hold before insert on reactions for each row execute function hold_window()`.execute(
      cloned.db,
    );

    try {
      const [first, second] = await Promise.all([
        call(cloned.db, 'PUT', reactionPath(room.root, '🦄'), alice.cookie),
        call(cloned.db, 'PUT', reactionPath(room.root, '🦊'), bob.cookie),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 400]);
    } finally {
      await sql`drop trigger hold on reactions`.execute(cloned.db);
    }

    const kinds = await cloned.db
      .selectFrom('reactions')
      .select('emoji')
      .where('message_id', '=', room.root)
      .groupBy('emoji')
      .execute();
    expect(kinds).toHaveLength(REACTION_KINDS_MAX);
  });
});
