/**
 * Group conversations through the HTTP surface (#486, D-127): a direct message of up to ten
 * people, whose people are its identity — the same set is the same conversation, in any order —
 * seen by its people alone, and telling every one of them what is written in it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Channel, CONVERSATION_PEOPLE_MAX, messageId, erasedPerson } from '@purlay/types';
import { createApp } from './app';
import { openConversationWith } from './channels';
import { NO_LOG, userTopic, type EventBus } from '../../platform/events';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aTestAuth, aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  as: SignedInUser,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        cookie: as.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** A workspace of `count` people; the first made it. */
const aWorkspace = async (
  db: Executor,
  count: number,
): Promise<{ workspaceId: string; people: SignedInUser[] }> => {
  const people: SignedInUser[] = [];
  for (let n = 0; n < count; n += 1) people.push(await aSignedInUser(db, clock, `gc${String(n)}`));
  const [owner] = people;
  if (owner === undefined) throw new Error('a workspace needs somebody');
  const created = await call(db, 'POST', '/api/workspaces', owner, {
    name: 'group',
    slug: aUniqueSlug('gc'),
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  for (const person of people.slice(1)) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: person.userId, role: 'member', joined_at: NOW })
      .execute();
  }
  return { workspaceId, people };
};

const open = async (
  db: Executor,
  workspaceId: string,
  as: SignedInUser,
  others: readonly SignedInUser[] | readonly string[],
): Promise<Response> =>
  await call(db, 'POST', `/api/workspaces/${workspaceId}/conversations`, as, {
    userIds: others.map((other) => (typeof other === 'string' ? other : other.userId)),
  });

const channelsOf = async (
  db: Executor,
  workspaceId: string,
  as: SignedInUser,
): Promise<Channel[]> =>
  (await (
    await call(db, 'GET', `/api/workspaces/${workspaceId}/channels`, as)
  ).json()) as Channel[];

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('integration: opening a group conversation', () => {
  test('makes one for these people, the same one in any order, with each of them in it', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 3);
      const [ann, ben, cat] = people as [SignedInUser, SignedInUser, SignedInUser];
      const first = await open(db, workspaceId, ann, [ben, cat]);
      expect(first.status).toBe(201);
      const made: unknown = await first.json();
      expect(Value.Check(Channel, made)).toBe(true);
      const group = made as Channel;
      expect(group.type).toBe('direct_message');
      // A group has no one other person; its people are in the order of its key.
      expect(group.peer).toBeNull();
      expect(group.peers.map((peer) => peer.id)).toEqual([ben.userId, cat.userId].sort(byKey));

      const again = await open(db, workspaceId, cat, [ben, ann]);
      expect(again.status).toBe(200);
      expect(((await again.json()) as Channel).id).toBe(group.id);

      for (const person of [ann, ben, cat]) {
        const seen = (await channelsOf(db, workspaceId, person)).find((c) => c.id === group.id);
        expect(seen?.peers.map((peer) => peer.id)).toEqual(
          [ann, ben, cat]
            .filter((other) => other !== person)
            .map((other) => other.userId)
            .sort(byKey),
        );
        expect(seen?.state).not.toBeNull();
      }
    });
  });

  test(`holds ${String(CONVERSATION_PEOPLE_MAX)} people, the caller counted, and not one more`, async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, CONVERSATION_PEOPLE_MAX + 1);
      const [owner, ...others] = people as [SignedInUser, ...SignedInUser[]];
      const atTheBound = others.slice(0, CONVERSATION_PEOPLE_MAX - 1);
      const opened = await open(db, workspaceId, owner, atTheBound);
      expect(opened.status).toBe(201);
      expect(((await opened.json()) as Channel).peers).toHaveLength(CONVERSATION_PEOPLE_MAX - 1);
      expect((await open(db, workspaceId, owner, others)).status).toBe(400);
    });
  });

  test('of two people is the direct message between them, as `/dms` opens it', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 2);
      const [ann, ben] = people as [SignedInUser, SignedInUser];
      const pair = (await (await open(db, workspaceId, ann, [ben])).json()) as Channel;
      expect(pair.peer?.id).toBe(ben.userId);
      expect(pair.peers.map((peer) => peer.id)).toEqual([ben.userId]);
      const dm = await call(db, 'POST', `/api/workspaces/${workspaceId}/dms`, ann, {
        userId: ben.userId,
      });
      expect(((await dm.json()) as Channel).id).toBe(pair.id);
      // A note to self: the caller alone.
      const self = (await (await open(db, workspaceId, ann, [ann])).json()) as Channel;
      expect(self.peers.map((peer) => peer.id)).toEqual([ann.userId]);
    });
  });

  test('refuses nobody, somebody twice, and the caller among others', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 3);
      const [ann, ben, cat] = people as [SignedInUser, SignedInUser, SignedInUser];
      expect((await open(db, workspaceId, ann, [])).status).toBe(400);
      expect((await open(db, workspaceId, ann, [ben, ben])).status).toBe(400);
      // Said as the field it is, not left to the key the database would refuse.
      const naming = await open(db, workspaceId, ann, [ann, ben, cat]);
      expect(naming.status).toBe(400);
      expect(await naming.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', details: { fields: { userIds: 'names the caller' } } },
      });
    });
  });

  test('somebody outside the workspace, or erased, is USER_NOT_FOUND, and nothing is made', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 3);
      const [ann, ben, cat] = people as [SignedInUser, SignedInUser, SignedInUser];
      // A person of another workspace, not merely of none.
      const elsewhere = await aWorkspace(db, 1);
      const [stranger] = elsewhere.people as [SignedInUser];
      const outside = await open(db, workspaceId, ann, [ben, stranger]);
      expect(outside.status).toBe(404);
      expect(await outside.json()).toMatchObject({ error: { code: 'USER_NOT_FOUND' } });
      await db.updateTable('users').set({ deleted_at: NOW }).where('id', '=', cat.userId).execute();
      expect((await open(db, workspaceId, ann, [ben, cat])).status).toBe(404);
      expect(
        (await channelsOf(db, workspaceId, ann)).filter((c) => c.type === 'direct_message'),
      ).toEqual([]);
    });
  });
});

describe('integration: a group conversation is its people’s', () => {
  test('a workspace member outside it does not see it, and cannot read it', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 4);
      const [ann, ben, cat, dan] = people as [
        SignedInUser,
        SignedInUser,
        SignedInUser,
        SignedInUser,
      ];
      const group = (await (await open(db, workspaceId, ann, [ben, cat])).json()) as Channel;
      expect((await channelsOf(db, workspaceId, dan)).map((c) => c.id)).not.toContain(group.id);
      expect((await call(db, 'GET', `/api/channels/${group.id}/messages`, dan)).status).toBe(404);
      expect(
        (
          await call(db, 'POST', `/api/channels/${group.id}/messages`, dan, {
            id: messageId(NOW),
            content: 'let me in',
          })
        ).status,
      ).toBe(404);
    });
  });

  test('a message in it tells every other person in it, not only one', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 3);
      const [ann, ben, cat] = people as [SignedInUser, SignedInUser, SignedInUser];
      const group = (await (await open(db, workspaceId, ann, [ben, cat])).json()) as Channel;
      const sent = await call(db, 'POST', `/api/channels/${group.id}/messages`, ann, {
        id: messageId(NOW),
        content: 'shipping at five',
      });
      expect(sent.status).toBe(201);
      for (const person of [ben, cat]) {
        const seen = (await channelsOf(db, workspaceId, person)).find((c) => c.id === group.id);
        expect({ who: person.username, state: seen?.state }).toMatchObject({
          who: person.username,
          state: { unreadCount: 1, unreadMentionCount: 1 },
        });
      }
    });
  });
});

describe('integration: a group’s people stay its people', () => {
  test('somebody removed from the workspace and let back in does not return to it', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 3);
      const [ann, ben, cat] = people as [SignedInUser, SignedInUser, SignedInUser];
      const group = (await (await open(db, workspaceId, ann, [ben, cat])).json()) as Channel;
      // Removed (D-111): out of the workspace and every channel in it; then invited back.
      await db.deleteFrom('channel_members').where('user_id', '=', cat.userId).execute();
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', cat.userId)
        .execute();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: cat.userId, role: 'member', joined_at: NOW })
        .execute();
      expect((await open(db, workspaceId, ann, [ben, cat])).status).toBe(200);
      expect((await open(db, workspaceId, cat, [ann, ben])).status).toBe(404);
      const members = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', group.id)
        .execute();
      expect(members.map((member) => member.user_id)).not.toContain(cat.userId);
      expect((await call(db, 'GET', `/api/channels/${group.id}/messages`, cat)).status).toBe(404);
    });
  });

  test('an erased person in it is named as such, and nothing their account held is handed out', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 3);
      const [ann, ben, cat] = people as [SignedInUser, SignedInUser, SignedInUser];
      const group = (await (await open(db, workspaceId, ann, [ben, cat])).json()) as Channel;
      await db
        .updateTable('users')
        .set({ deleted_at: NOW, avatar_url: 'https://avatars.example/cat.png' })
        .where('id', '=', cat.userId)
        .execute();
      const seen = (await channelsOf(db, workspaceId, ann)).find((c) => c.id === group.id);
      expect(seen?.peers.find((peer) => peer.id === cat.userId)).toEqual(erasedPerson(cat.userId));
    });
  });

  test('its other people are told it exists, once, when it is made — nobody else', async () => {
    await withRollback(async (db) => {
      const { workspaceId, people } = await aWorkspace(db, 4);
      const [ann, ben, cat] = people as [SignedInUser, SignedInUser, SignedInUser];
      const topics: string[] = [];
      const bus: EventBus = {
        publish: (topic, frame): Promise<void> => {
          if (frame.event === 'CHANNEL_ADDED') topics.push(topic);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const request = (): Request =>
        new Request('https://purlay.test/', { headers: { cookie: ann.cookie } });
      const dependencies = { auth: aTestAuth(db), database: db, clock, bus, log: NO_LOG };
      const body = { userIds: [cat.userId, ben.userId] };
      await openConversationWith(dependencies, request(), workspaceId, body);
      await openConversationWith(dependencies, request(), workspaceId, body);
      expect(topics.sort()).toEqual([userTopic(ben.userId), userTopic(cat.userId)].sort());
    });
  });
});
