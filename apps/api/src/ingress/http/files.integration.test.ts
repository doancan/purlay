/**
 * `GET /api/channels/:channelId/files` through the HTTP surface (#485, D-129): a channel's files,
 * newest message first, of messages not deleted — never an unattached upload, never another
 * channel's — paged on the message and then the file, and refused as the channel is.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { messageId, PAGE_LIMIT, type FilePage } from '@purlay/types';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 60_000 + (tick += 1)));

interface World {
  readonly db: Executor;
  readonly call: (
    method: string,
    path: string,
    who: SignedInUser | null,
    body?: unknown,
  ) => Promise<Response>;
  readonly owner: SignedInUser;
  /** In the workspace and its public channel, not in the private one. */
  readonly member: SignedInUser;
  /** In another workspace altogether. */
  readonly stranger: SignedInUser;
  readonly publicChannel: string;
  readonly privateChannel: string;
  readonly workspaceId: string;
}

const aWorld = async (db: Executor): Promise<World> => {
  const store = aMemoryStore();
  const call: World['call'] = async (method, path, who, body) => {
    const headers: Record<string, string> = who === null ? {} : { cookie: who.cookie };
    let payload: Uint8Array | string | undefined;
    if (body instanceof Uint8Array) {
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = String(body.length);
      payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return await createApp(testDependencies({ database: db, clock, storage: store })).handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      }),
    );
  };
  const idOf = async (response: Response): Promise<string> =>
    ((await response.json()) as { id: string }).id;
  const owner = await aSignedInUser(db, clock, 'cf-owner');
  const member = await aSignedInUser(db, clock, 'cf-member');
  const stranger = await aSignedInUser(db, clock, 'cf-stranger');
  const slug = aUniqueSlug('cf');
  const workspaceId = await idOf(
    await call('POST', '/api/workspaces', owner, { name: slug, slug }),
  );
  await call('POST', '/api/workspaces', stranger, { name: 'x', slug: aUniqueSlug('cf-x') });
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: member.userId, role: 'member', joined_at: NOW })
    .execute();
  const channels = `/api/workspaces/${workspaceId}/channels`;
  const publicChannel = await idOf(await call('POST', channels, owner, { name: 'general' }));
  const privateChannel = await idOf(
    await call('POST', channels, owner, { name: 'secret', type: 'private' }),
  );
  expect((await call('POST', `/api/channels/${publicChannel}/join`, member)).ok).toBe(true);
  return { db, call, owner, member, stranger, publicChannel, privateChannel, workspaceId };
};

/** An upload of the owner's, unattached; its id. */
const upload = async (world: World, name: string): Promise<string> => {
  const id = anId();
  const response = await world.call(
    'POST',
    `/api/workspaces/${world.workspaceId}/uploads?id=${id}&name=${encodeURIComponent(name)}`,
    world.owner,
    new TextEncoder().encode(name),
  );
  expect(response.status).toBe(201);
  return id;
};

/** A message of the owner's in this channel carrying new uploads of these names. */
const sendWith = async (
  world: World,
  channelId: string,
  names: string[],
  parentId?: string,
): Promise<{ message: string; files: string[] }> => {
  const files: string[] = [];
  for (const name of names) files.push(await upload(world, name));
  const message = anId();
  const response = await world.call('POST', `/api/channels/${channelId}/messages`, world.owner, {
    id: message,
    content: 'look',
    attachmentIds: files,
    ...(parentId === undefined ? {} : { parentId }),
  });
  expect(response.status).toBe(201);
  return { message, files };
};

const filesOf = async (
  world: World,
  channelId: string,
  who: SignedInUser,
  query = '',
): Promise<FilePage> => {
  const response = await world.call('GET', `/api/channels/${channelId}/files${query}`, who);
  expect(response.status).toBe(200);
  return (await response.json()) as FilePage;
};

const refusal = async (
  world: World,
  path: string,
  who: SignedInUser | null,
): Promise<[number, string]> => {
  const response = await world.call('GET', path, who);
  const body = (await response.json()) as { error: { code: string } };
  return [response.status, body.error.code];
};

describe('integration: a channel’s files', () => {
  test('newest message first, its files newest first, with who said it, when and where', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const first = await sendWith(world, world.publicChannel, ['a.txt', 'b.txt']);
      const second = await sendWith(world, world.publicChannel, ['c.txt']);
      const reply = await sendWith(world, world.publicChannel, ['d.txt'], first.message);
      await sendWith(world, world.privateChannel, ['elsewhere.txt']);
      await upload(world, 'never-sent.txt');

      const page = await filesOf(world, world.publicChannel, world.member);

      expect(page.nextCursor).toBeNull();
      expect(page.data.map((file) => file.attachment.fileName)).toEqual([
        'd.txt',
        'c.txt',
        'b.txt',
        'a.txt',
      ]);
      expect(page.data[0]).toMatchObject({
        attachment: { id: reply.files[0], kind: 'file', mimeType: 'application/octet-stream' },
        messageId: reply.message,
        parentId: first.message,
        sender: { id: world.owner.userId },
        sentAt: NOW.toISOString(),
      });
      expect(page.data[1]).toMatchObject({ messageId: second.message, parentId: null });
    });
  });

  test('a deleted message takes its files with it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const kept = await sendWith(world, world.publicChannel, ['kept.txt']);
      const gone = await sendWith(world, world.publicChannel, ['gone.txt']);
      expect(
        (await world.call('DELETE', `/api/messages/${gone.message}`, world.owner)).status,
      ).toBe(204);

      const page = await filesOf(world, world.publicChannel, world.owner);

      expect(page.data.map((file) => file.attachment.id)).toEqual(kept.files);
    });
  });

  test('pages run through a message’s files and on to the next, each once', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const older = await sendWith(world, world.publicChannel, ['1.txt', '2.txt', '3.txt']);
      const newer = await sendWith(world, world.publicChannel, ['4.txt', '5.txt']);

      const one = await filesOf(world, world.publicChannel, world.member, '?limit=3');
      const two = await filesOf(
        world,
        world.publicChannel,
        world.member,
        `?limit=3&before=${String(one.nextCursor)}`,
      );

      expect(one.data.map((file) => file.attachment.id)).toEqual([
        ...newer.files.toReversed(),
        older.files[2],
      ]);
      expect(one.nextCursor).toBe(older.files[2] ?? null);
      expect(two.data.map((file) => file.attachment.id)).toEqual(
        older.files.slice(0, 2).toReversed(),
      );
      expect(two.nextCursor).toBeNull();
    });
  });

  test('a page exactly as long as what is left says it is the last', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await sendWith(world, world.publicChannel, ['1.txt', '2.txt']);

      expect((await filesOf(world, world.publicChannel, world.member, '?limit=2')).nextCursor).toBe(
        null,
      );
      expect(
        (await filesOf(world, world.publicChannel, world.member, '?limit=1')).nextCursor,
      ).not.toBeNull();
    });
  });

  test('an empty channel has an empty page', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(await filesOf(world, world.publicChannel, world.member)).toEqual({
        data: [],
        nextCursor: null,
      });
    });
  });
});

describe('integration: a channel’s files are refused as the channel is', () => {
  test('a private channel the caller is not in, and another workspace’s, are 404', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await sendWith(world, world.privateChannel, ['secret.txt']);
      const path = `/api/channels/${world.privateChannel}/files`;

      expect(await refusal(world, path, world.member)).toEqual([404, 'CHANNEL_NOT_FOUND']);
      expect(await refusal(world, path, world.stranger)).toEqual([404, 'CHANNEL_NOT_FOUND']);
      expect(await refusal(world, path, null)).toEqual([401, 'UNAUTHENTICATED']);
    });
  });

  test('a cursor from another channel, or an upload never sent, is refused rather than read', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await sendWith(world, world.publicChannel, ['here.txt']);
      const elsewhere = await sendWith(world, world.privateChannel, ['there.txt']);
      const unsent = await upload(world, 'unsent.txt');
      const path = `/api/channels/${world.publicChannel}/files?before=`;

      for (const cursor of [elsewhere.files[0], unsent, anId()]) {
        expect(await refusal(world, `${path}${String(cursor)}`, world.owner)).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
      }
    });
  });

  test('a limit outside its bounds is refused', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const path = `/api/channels/${world.publicChannel}/files?limit=`;

      expect(await refusal(world, `${path}0`, world.member)).toEqual([400, 'VALIDATION_FAILED']);
      expect(await refusal(world, `${path}${String(PAGE_LIMIT.max + 1)}`, world.member)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
      expect(
        (
          await world.call(
            'GET',
            `${path.slice(0, -7)}?limit=${String(PAGE_LIMIT.max)}`,
            world.member,
          )
        ).status,
      ).toBe(200);
    });
  });
});

describe('integration: an attachment’s channel is its message’s (0027)', () => {
  test('linked without a channel, or in another channel than its message, is refused', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const sent = await sendWith(world, world.publicChannel, ['a.txt']);
      const file = sent.files[0] ?? '';
      const refused = async (channelId: string | null): Promise<string> => {
        await sql`savepoint attempt`.execute(db);
        try {
          await db
            .updateTable('attachments')
            .set({ channel_id: channelId })
            .where('id', '=', file)
            .execute();
          await sql`release savepoint attempt`.execute(db);
          return 'taken';
        } catch (error) {
          await sql`rollback to savepoint attempt`.execute(db);
          return error instanceof Error ? error.message : String(error);
        }
      };

      expect(await refused(null)).toContain('attachments_channel_iff_message');
      expect(await refused(world.privateChannel)).toContain('attachments_message_channel_fkey');
      const row = await db
        .selectFrom('attachments')
        .select('channel_id')
        .where('id', '=', file)
        .executeTakeFirstOrThrow();
      expect(row.channel_id).toBe(world.publicChannel);
    });
  });
});
