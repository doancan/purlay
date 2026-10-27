/**
 * `GET /api/channels/:channelId/changes` (D-194): what happened to a channel's messages since a client last
 * heard — a message that arrived, was edited, was deleted, was reacted to, was answered — read back as the
 * messages themselves, in the order they happened *to the server*, and never the order their ids sort in.
 *
 * What is checked is the ways a client would be left wrong without noticing: a deletion that is never told, a
 * reaction taken back that is still shown, a message that arrived late under an older id, a page boundary that
 * skips or repeats a change, a cursor that was made up, a channel the caller cannot see.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { CHANGES_OVERLAP_MS, ChangePage, MESSAGE_ID_SKEW, messageId } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

interface World {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly channelId: string;
  readonly workspaceId: string;
}

const aWorld = async (db: Executor, name: string): Promise<World> => {
  const alice = await aSignedInUser(db, clock, `${name}-a`);
  const bob = await aSignedInUser(db, clock, `${name}-b`);
  const made = await call(db, 'POST', '/api/workspaces', {
    cookie: alice.cookie,
    body: { name, slug: aUniqueSlug(name) },
  });
  const workspaceId = ((await made.json()) as { id: string }).id;
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
    cookie: alice.cookie,
    body: { name: 'ops' },
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  await db
    .insertInto('channel_members')
    .values({ channel_id: channelId, user_id: bob.userId, joined_at: NOW })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  return { alice, bob, channelId, workspaceId };
};

let tick = 0;
const anId = (at: Date = NOW): string => messageId(new Date(at.getTime() + (tick += 1)));

const send = async (
  db: Executor,
  world: World,
  content: string,
  extra: { id?: string; parentId?: string } = {},
): Promise<string> => {
  const id = extra.id ?? anId();
  const response = await call(db, 'POST', `/api/channels/${world.channelId}/messages`, {
    cookie: world.alice.cookie,
    body: { id, content, ...(extra.parentId === undefined ? {} : { parentId: extra.parentId }) },
  });
  expect(response.status).toBe(201);
  return id;
};

const changes = async (
  db: Executor,
  world: World,
  query: string,
  cookie: string = world.bob.cookie,
): Promise<{ status: number; page: ChangePage }> => {
  const response = await call(db, 'GET', `/api/channels/${world.channelId}/changes${query}`, {
    cookie,
  });
  const body: unknown = await response.json();
  if (response.status === 200) expect(Value.Check(ChangePage, body)).toBe(true);
  return { status: response.status, page: body as ChangePage };
};

/**
 * Puts rows back in time, as the days a client was away put them: a read reaches `CHANGES_OVERLAP_MS` behind its
 * watermark on purpose, so what the test made a moment ago is inside it and is told again, to be dropped by id.
 * The stamp is left alone when a statement sets it (0058), so this is the way to make a change old.
 */
const settle = async (db: Executor, ids: readonly string[]): Promise<void> => {
  await db
    .updateTable('messages')
    .set({ changed_at: new Date(Date.now() - 10 * 60_000) })
    .where('id', 'in', ids)
    .execute();
};

/** Where a client is when it has just read: the watermark with nothing in it. */
const watermark = async (db: Executor, world: World): Promise<string> =>
  (await changes(db, world, '')).page.asOf;

const idsOf = (page: ChangePage): string[] => page.data.map((message) => message.id);

describe('integration: the changes of a channel', () => {
  test('asked with nothing, it says where the server is and returns nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-mark');
      await send(db, world, 'before');
      const { status, page } = await changes(db, world, '');
      expect(status).toBe(200);
      expect(page.data).toEqual([]);
      expect(page.nextCursor).toBeNull();
      const { now } = await db
        .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
        .executeTakeFirstOrThrow();
      expect(Math.abs(Date.parse(page.asOf) - now.getTime())).toBeLessThan(5_000);
    });
  });

  test('a new message, an edit and a deletion each come back as the message, a deletion as its tombstone', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-basic');
      const kept = await send(db, world, 'one');
      const edited = await send(db, world, 'two');
      const deleted = await send(db, world, 'three');
      await settle(db, [kept, edited, deleted]);
      const since = await watermark(db, world);

      const fresh = await send(db, world, 'four');
      expect(
        (
          await call(db, 'PATCH', `/api/messages/${edited}`, {
            cookie: world.alice.cookie,
            body: { content: 'two, said better' },
          })
        ).status,
      ).toBe(200);
      expect(
        (await call(db, 'DELETE', `/api/messages/${deleted}`, { cookie: world.alice.cookie }))
          .status,
      ).toBe(204);

      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      expect(new Set(idsOf(page))).toEqual(new Set([fresh, edited, deleted]));
      expect(idsOf(page)).not.toContain(kept);
      const byId = new Map(page.data.map((message) => [message.id, message]));
      expect(byId.get(edited)).toMatchObject({ content: 'two, said better' });
      expect(byId.get(edited)?.editedAt).not.toBeNull();
      // A root nobody answered is left out of the feed once deleted: only here is the client told.
      expect(byId.get(deleted)?.deletedAt).not.toBeNull();
      expect(byId.get(deleted)?.content).not.toBe('three');
    });
  });

  test('a reaction added and one taken back are both told, the set as it stands', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-react');
      const first = await send(db, world, 'react to me');
      const second = await send(db, world, 'and to me');
      await call(db, 'PUT', `/api/messages/${second}/reactions/${encodeURIComponent('👍')}`, {
        cookie: world.bob.cookie,
      });
      await settle(db, [first, second]);
      const since = await watermark(db, world);

      await call(db, 'PUT', `/api/messages/${first}/reactions/${encodeURIComponent('🎉')}`, {
        cookie: world.bob.cookie,
      });
      await call(db, 'DELETE', `/api/messages/${second}/reactions/${encodeURIComponent('👍')}`, {
        cookie: world.bob.cookie,
      });

      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      const byId = new Map(page.data.map((message) => [message.id, message]));
      expect(byId.get(first)?.reactions.map((reaction) => reaction.emoji)).toEqual(['🎉']);
      expect(byId.get(second)?.reactions).toEqual([]);
    });
  });

  test('a reply is told with its root, whose count it moved', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-reply');
      const root = await send(db, world, 'a root');
      await settle(db, [root]);
      const since = await watermark(db, world);
      const reply = await send(db, world, 'an answer', { parentId: root });
      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      expect(new Set(idsOf(page))).toEqual(new Set([root, reply]));
      expect(page.data.find((message) => message.id === root)?.thread?.replyCount).toBe(1);
      expect(page.data.find((message) => message.id === reply)?.parentId).toBe(root);
    });
  });

  test('a message that arrives under an id older than the newest one held is told all the same', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-late');
      const newest = await send(db, world, 'the newest the client holds');
      await settle(db, [newest]);
      const since = await watermark(db, world);
      // Sent from a laptop that sat offline: an id half a minute behind the clock (D-33).
      const late = await send(db, world, 'arrived late', {
        id: anId(new Date(NOW.getTime() - MESSAGE_ID_SKEW.behindMs / 2)),
      });
      expect(late < newest).toBe(true);
      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      expect(idsOf(page)).toEqual([late]);
    });
  });

  test('is in the order things happened, and a page boundary neither skips nor repeats a change', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-pages');
      const made: string[] = [];
      for (let n = 0; n < 5; n += 1) made.push(await send(db, world, `m${String(n)}`));
      await settle(db, made);
      const since = await watermark(db, world);
      // Touched in an order of their own, not the order their ids sort in.
      const order = [made[3], made[0], made[4], made[1]] as string[];
      for (const [place, id] of order.entries()) {
        await call(db, 'PATCH', `/api/messages/${id}`, {
          cookie: world.alice.cookie,
          body: { content: `edited ${id}` },
        });
        // Stamped by the database in the millisecond it happened; two edits can share one, and the id then
        // decides. A stamp of its own per edit makes the order under test the order of the edits.
        await db
          .updateTable('messages')
          .set({ changed_at: new Date(Date.now() - 5_000 + place * 100) })
          .where('id', '=', id)
          .execute();
      }
      const seen: string[] = [];
      const asOfs = new Set<string>();
      let query = `?since=${encodeURIComponent(since)}&limit=3`;
      for (let pages = 0; pages < 5; pages += 1) {
        const { status, page } = await changes(db, world, query);
        expect(status).toBe(200);
        asOfs.add(page.asOf);
        seen.push(...idsOf(page));
        if (page.nextCursor === null) break;
        query = `?after=${encodeURIComponent(page.nextCursor)}&limit=3`;
      }
      expect(seen).toEqual(order);
      expect(asOfs.size).toBe(1);
    });
  });

  test('rows stamped in the same instant are all told, whatever the page size, each once', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-ties');
      const made: string[] = [];
      for (let n = 0; n < 5; n += 1) made.push(await send(db, world, `t${String(n)}`));
      const since = await watermark(db, world);
      const stamp = new Date(Date.now() - 1_000);
      await db.updateTable('messages').set({ changed_at: stamp }).where('id', 'in', made).execute();
      const seen: string[] = [];
      let query = `?since=${encodeURIComponent(since)}&limit=2`;
      for (let pages = 0; pages < 6; pages += 1) {
        const { page } = await changes(db, world, query);
        seen.push(...idsOf(page));
        if (page.nextCursor === null) break;
        query = `?after=${encodeURIComponent(page.nextCursor)}&limit=2`;
      }
      expect(seen).toEqual([...made].sort());
    });
  });

  test('a change made while a walk is being read belongs to the next walk, found from the watermark the first gave', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-during');
      const made: string[] = [];
      for (let n = 0; n < 3; n += 1) made.push(await send(db, world, `d${String(n)}`));
      await settle(db, made);
      const since = await watermark(db, world);
      const edit = async (id: string | undefined, content: string): Promise<void> => {
        await call(db, 'PATCH', `/api/messages/${id ?? ''}`, {
          cookie: world.alice.cookie,
          body: { content },
        });
      };
      await edit(made[0], 'edited before the walk');
      await edit(made[1], 'edited before the walk, too');
      const first = await changes(db, world, `?since=${encodeURIComponent(since)}&limit=1`);
      expect(idsOf(first.page)).toEqual([made[0]!]);
      expect(first.page.nextCursor).not.toBeNull();
      // Edited after the walk began, while a client is still reading it.
      await edit(made[2], 'edited during the walk');
      const second = await changes(
        db,
        world,
        `?after=${encodeURIComponent(first.page.nextCursor ?? '')}&limit=10`,
      );
      expect(idsOf(second.page)).toEqual([made[1]!]);
      expect(second.page.nextCursor).toBeNull();
      expect(second.page.asOf).toBe(first.page.asOf);
      const next = await changes(db, world, `?since=${encodeURIComponent(first.page.asOf)}`);
      expect(idsOf(next.page)).toContain(made[2]!);
    });
  });

  test('what changed less than the overlap before the watermark is still told, and what changed long before is not', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-overlap');
      const recent = await send(db, world, 'a little before');
      const old = await send(db, world, 'long before');
      await db
        .updateTable('messages')
        .set({ changed_at: new Date(Date.now() - 20_000) })
        .where('id', '=', recent)
        .execute();
      await db
        .updateTable('messages')
        .set({ changed_at: new Date(Date.now() - 3_600_000) })
        .where('id', '=', old)
        .execute();
      const since = new Date().toISOString();
      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      expect(idsOf(page)).toContain(recent);
      expect(idsOf(page)).not.toContain(old);
    });
  });

  test('a change made by any statement on the row stamps it, whoever made it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-trigger');
      const id = await send(db, world, 'to be erased by a job');
      await settle(db, [id]);
      const since = await watermark(db, world);
      // What a retention job or an erasure does: no route, no service of ours, a bare statement.
      await db.updateTable('messages').set({ content: '' }).where('id', '=', id).execute();
      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      expect(idsOf(page)).toEqual([id]);
    });
  });
});

describe('integration: more of what a channel can do', () => {
  test('a reaction on a reply, a resolved thread and a deleted root with replies are each told', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-more');
      const root = await send(db, world, 'a question');
      const reply = await send(db, world, 'an answer', { parentId: root });
      const gone = await send(db, world, 'a root that will be deleted');
      const goneReply = await send(db, world, 'its answer', { parentId: gone });
      await settle(db, [root, reply, gone, goneReply]);
      const since = await watermark(db, world);

      await call(db, 'PUT', `/api/messages/${reply}/reactions/${encodeURIComponent('👍')}`, {
        cookie: world.bob.cookie,
      });
      expect(
        (await call(db, 'POST', `/api/messages/${root}/resolve`, { cookie: world.bob.cookie }))
          .status,
      ).toBe(200);
      expect(
        (await call(db, 'DELETE', `/api/messages/${gone}`, { cookie: world.alice.cookie })).status,
      ).toBe(204);

      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      const byId = new Map(page.data.map((message) => [message.id, message]));
      expect(byId.get(reply)?.reactions.map((reaction) => reaction.emoji)).toEqual(['👍']);
      expect(byId.get(root)?.thread?.resolvedAt).not.toBeNull();
      expect(byId.get(gone)?.deletedAt).not.toBeNull();
      expect(byId.get(gone)?.thread?.replyCount).toBe(1);
      expect(byId.has(goneReply)).toBe(false);
    });
  });

  test('a stamp a statement sets itself is kept, and a row inserted has one with no route involved', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-stamp');
      const id = await send(db, world, 'stamped');
      const chosen = new Date('2026-01-02T03:04:05.678Z');
      await db
        .updateTable('messages')
        .set({ changed_at: chosen, content: 'edited by a repair' })
        .where('id', '=', id)
        .execute();
      const kept = await db
        .selectFrom('messages')
        .select('changed_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(kept.changed_at.toISOString()).toBe(chosen.toISOString());

      const bare = anId();
      await db
        .insertInto('messages')
        .values({
          id: bare,
          workspace_id: world.workspaceId,
          channel_id: world.channelId,
          sender_id: world.alice.userId,
          content: 'inserted by a script',
        })
        .execute();
      const stamped = await db
        .selectFrom('messages')
        .select('changed_at')
        .where('id', '=', bare)
        .executeTakeFirstOrThrow();
      expect(Math.abs(stamped.changed_at.getTime() - Date.now())).toBeLessThan(5_000);
      // To the millisecond: a client holds it as an instant, and a cursor is made of it.
      expect(stamped.changed_at.getTime() % 1).toBe(0);
    });
  });

  test('exactly a page of changes is one page, and one more is two', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-exact');
      const made: string[] = [];
      for (let n = 0; n < 3; n += 1) made.push(await send(db, world, `e${String(n)}`));
      const since = await watermark(db, world);
      const exact = await changes(db, world, `?since=${encodeURIComponent(since)}&limit=3`);
      expect(exact.page.nextCursor).toBeNull();
      expect(exact.page.data).toHaveLength(3);
      const short = await changes(db, world, `?since=${encodeURIComponent(since)}&limit=2`);
      expect(short.page.nextCursor).not.toBeNull();
      const maximum = await changes(db, world, `?since=${encodeURIComponent(since)}&limit=100`);
      expect(maximum.status).toBe(200);
      expect(
        (await changes(db, world, `?since=${encodeURIComponent(since)}&limit=101`)).status,
      ).toBe(400);
    });
  });

  test('a watermark in the future tells nothing yet, and one long ago tells everything held back from it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-edges');
      const id = await send(db, world, 'now');
      const future = await changes(
        db,
        world,
        `?since=${encodeURIComponent('2999-01-01T00:00:00Z')}`,
      );
      expect(future.status).toBe(200);
      expect(future.page.data).toEqual([]);
      const ancient = await changes(
        db,
        world,
        `?since=${encodeURIComponent('1970-01-01T00:00:00Z')}`,
      );
      expect(idsOf(ancient.page)).toContain(id);
      expect((await changes(db, world, '?since=')).status).toBe(400);
    });
  });

  test('the overlap is the number it is named for: a change one second inside it is told, one second outside is not', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-boundary');
      const inside = await send(db, world, 'inside');
      const outside = await send(db, world, 'outside');
      const since = await watermark(db, world);
      const at = Date.parse(since);
      await db
        .updateTable('messages')
        .set({ changed_at: new Date(at - CHANGES_OVERLAP_MS + 1_000) })
        .where('id', '=', inside)
        .execute();
      await db
        .updateTable('messages')
        .set({ changed_at: new Date(at - CHANGES_OVERLAP_MS - 1_000) })
        .where('id', '=', outside)
        .execute();
      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      expect(idsOf(page)).toContain(inside);
      expect(idsOf(page)).not.toContain(outside);
    });
  });
});

describe('integration: the changes of a channel the caller may not read', () => {
  test('a private channel, a direct message, a deleted channel and a member since removed are refused as their history is', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-closed');
      const third = await aSignedInUser(db, clock, 'changes-closed-c');
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: world.workspaceId,
          user_id: third.userId,
          role: 'member',
          joined_at: NOW,
        })
        .execute();
      const seed = async (
        values: { type: 'public' | 'private' | 'direct_message' } & Record<string, unknown>,
        members: readonly string[],
      ): Promise<string> => {
        const row = await db
          .insertInto('channels')
          .values({ workspace_id: world.workspaceId, created_by: world.alice.userId, ...values })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const user of members) {
          await db
            .insertInto('channel_members')
            .values({ channel_id: row.id, user_id: user, joined_at: NOW })
            .execute();
        }
        return row.id;
      };
      const pair = [world.alice.userId, third.userId].sort().join(':');
      const closed = {
        private: await seed({ type: 'private', name: 'leadership' }, [world.alice.userId]),
        'direct message': await seed({ type: 'direct_message', name: null, dm_key: pair }, [
          world.alice.userId,
          third.userId,
        ]),
        deleted: await seed({ type: 'public', name: 'gone', deleted_at: NOW }, [
          world.alice.userId,
        ]),
      };
      const removed = await seed({ type: 'private', name: 'was-mine' }, [
        world.alice.userId,
        world.bob.userId,
      ]);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', removed)
        .where('user_id', '=', world.bob.userId)
        .execute();
      for (const [label, channelId] of [...Object.entries(closed), ['removed', removed]] as const) {
        const history = await call(db, 'GET', `/api/channels/${channelId}/messages`, {
          cookie: world.bob.cookie,
        });
        const asked = await call(db, 'GET', `/api/channels/${channelId}/changes`, {
          cookie: world.bob.cookie,
        });
        expect([label, asked.status]).toEqual([label, history.status]);
        expect([label, await asked.json()]).toEqual([label, await history.json()]);
        expect(asked.status).not.toBe(200);
      }
    });
  });

  test('another workspace’s channel is not read through this one, and a cursor made elsewhere reads nothing of it', async () => {
    await withRollback(async (db) => {
      const mine = await aWorld(db, 'changes-ws-a');
      const theirs = await aWorld(db, 'changes-ws-b');
      const secret = await send(db, theirs, 'not for the other workspace');
      const since = await watermark(db, mine);
      const across = await call(db, 'GET', `/api/channels/${theirs.channelId}/changes`, {
        cookie: mine.alice.cookie,
      });
      expect(across.status).toBeGreaterThanOrEqual(400);
      const walked = await changes(db, theirs, `?since=${encodeURIComponent(since)}&limit=1`);
      expect(idsOf(walked.page)).toEqual([secret]);
      const cursor =
        walked.page.nextCursor ?? `${String(Date.now())}.${secret}.${String(Date.now())}`;
      const reused = await call(
        db,
        'GET',
        `/api/channels/${mine.channelId}/changes?after=${encodeURIComponent(cursor)}`,
        { cookie: mine.alice.cookie },
      );
      expect(JSON.stringify(await reused.json())).not.toContain(secret);
    });
  });
});

describe('integration: who may read the changes', () => {
  test('another channel’s changes are not in it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-other');
      const second = await call(db, 'POST', `/api/workspaces/${world.workspaceId}/channels`, {
        cookie: world.alice.cookie,
        body: { name: 'elsewhere' },
      });
      const elsewhere = ((await second.json()) as { id: string }).id;
      const since = await watermark(db, world);
      await call(db, 'POST', `/api/channels/${elsewhere}/messages`, {
        cookie: world.alice.cookie,
        body: { id: anId(), content: 'not here' },
      });
      const { page } = await changes(db, world, `?since=${encodeURIComponent(since)}`);
      expect(page.data).toEqual([]);
    });
  });

  test('somebody who cannot see the channel is told it is not there, as for its history', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-hidden');
      const stranger = await aSignedInUser(db, clock, 'changes-stranger');
      const history = await call(db, 'GET', `/api/channels/${world.channelId}/messages`, {
        cookie: stranger.cookie,
      });
      const asked = await changes(db, world, '', stranger.cookie);
      expect(asked.status).toBe(history.status);
      const refusal: unknown = await history.json();
      expect(asked.page as unknown).toEqual(refusal);
      expect((await changes(db, world, '', '')).status).toBe(401);
    });
  });

  test('a cursor nobody made, both a cursor and a since, and a query it does not know are refused', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'changes-refuse');
      const since = encodeURIComponent(await watermark(db, world));
      const forged = [
        '?after=nonsense',
        `?after=1.${anId()}.1`,
        `?after=9999999999999.${anId()}`,
        `?since=${since}&after=9999999999999.${anId()}.9999999999999`,
        '?since=yesterday',
        `?since=${since}&bogus=1`,
        `?since=${since}&since=${since}`,
        `?since=${since}&limit=0`,
        `?since=${since}&limit=1e1`,
        // Well made, and from the future: a watermark this server never held, which a client would keep.
        `?after=9999999999999.${anId()}.9999999999999`,
        // Well made, and stamped after the walk it says it belongs to.
        `?after=${String(Date.now())}.${anId()}.${String(Date.now() - 60_000)}`,
      ];
      for (const query of forged) {
        const { status } = await changes(db, world, query);
        expect([query, status]).toEqual([query, 400]);
      }
    });
  });
});
