/**
 * `/api/attachments/:attachmentId` through the HTTP surface (D-109 §5, §6, #111): who may read the
 * bytes behind an id, how they are served so that nothing in them runs on this origin, and who may
 * throw one away.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { twoColourPng } from '../../testing/png';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 60_000 + (tick += 1)));

interface World {
  readonly db: Executor;
  readonly store: MemoryStore;
  readonly call: (
    method: string,
    path: string,
    who: SignedInUser | null,
    body?: unknown,
    more?: Record<string, string>,
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
  const call: World['call'] = async (method, path, who, body, more = {}) => {
    const headers: Record<string, string> = {
      ...more,
      ...(who === null ? {} : { cookie: who.cookie }),
    };
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
  const owner = await aSignedInUser(db, clock, 'dl-owner');
  const member = await aSignedInUser(db, clock, 'dl-member');
  const stranger = await aSignedInUser(db, clock, 'dl-stranger');
  const slug = aUniqueSlug('dl');
  const workspaceId = await idOf(
    await call('POST', '/api/workspaces', owner, { name: slug, slug }),
  );
  await call('POST', '/api/workspaces', stranger, { name: 'x', slug: aUniqueSlug('dl-x') });
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: member.userId, role: 'member', joined_at: NOW })
    .execute();
  const channels = `/api/workspaces/${workspaceId}/channels`;
  const publicChannel = await idOf(await call('POST', channels, owner, { name: 'ops' }));
  const privateChannel = await idOf(
    await call('POST', channels, owner, { name: 'secret', type: 'private' }),
  );
  expect((await call('POST', `/api/channels/${publicChannel}/join`, member)).ok).toBe(true);
  return { db, store, call, owner, member, stranger, publicChannel, privateChannel, workspaceId };
};

/** An upload of `who`'s, unattached; its id. */
const upload = async (
  world: World,
  who: SignedInUser,
  name: string,
  bytes: Uint8Array,
): Promise<string> => {
  const id = anId();
  const response = await world.call(
    'POST',
    `/api/workspaces/${world.workspaceId}/uploads?id=${id}&name=${encodeURIComponent(name)}`,
    who,
    bytes,
  );
  expect(response.status).toBe(201);
  return id;
};

/** A message of the owner's in this channel carrying these uploads; its id. */
const sendWith = async (world: World, channelId: string, ids: string[]): Promise<string> => {
  const id = anId();
  const response = await world.call('POST', `/api/channels/${channelId}/messages`, world.owner, {
    id,
    content: 'look',
    attachmentIds: ids,
  });
  expect(response.status).toBe(201);
  return id;
};

const statusOf = async (world: World, path: string, who: SignedInUser): Promise<string> => {
  const response = await world.call('GET', path, who);
  if (response.ok) return String(response.status);
  return `${String(response.status)} ${((await response.json()) as { error: { code: string } }).error.code}`;
};

describe('integration: reading an attachment', () => {
  test('unsent, it is its uploader’s alone; sent, whoever sees the channel’s — and nobody else’s', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const file = await upload(world, world.owner, 'notes.txt', new Uint8Array([1, 2, 3]));
      const at = `/api/attachments/${file}`;
      expect(await statusOf(world, at, world.owner)).toBe('200');
      expect(await statusOf(world, at, world.member)).toBe('404 ATTACHMENT_NOT_FOUND');

      await sendWith(world, world.publicChannel, [file]);
      expect(await statusOf(world, at, world.member)).toBe('200');
      expect(await statusOf(world, at, world.stranger)).toBe('404 ATTACHMENT_NOT_FOUND');

      const hidden = await upload(world, world.owner, 'plans.txt', new Uint8Array([4]));
      await sendWith(world, world.privateChannel, [hidden]);
      expect(await statusOf(world, `/api/attachments/${hidden}`, world.owner)).toBe('200');
      expect(await statusOf(world, `/api/attachments/${hidden}`, world.member)).toBe(
        '404 ATTACHMENT_NOT_FOUND',
      );
      // An id that never existed, and one that is not an id, are refused alike.
      expect(await statusOf(world, `/api/attachments/${anId()}`, world.owner)).toBe(
        '404 ATTACHMENT_NOT_FOUND',
      );
      expect(await statusOf(world, '/api/attachments/nope', world.owner)).toBe(
        '404 ATTACHMENT_NOT_FOUND',
      );
      expect((await world.call('GET', at, null)).status).toBe(401);
    });
  });

  test('an uploader who has left the workspace no longer reads what they never sent', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const id = await upload(world, world.member, 'draft.txt', new Uint8Array([1]));
      expect(await statusOf(world, `/api/attachments/${id}`, world.member)).toBe('200');
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', world.workspaceId)
        .where('user_id', '=', world.member.userId)
        .execute();
      expect(await statusOf(world, `/api/attachments/${id}`, world.member)).toBe(
        '404 ATTACHMENT_NOT_FOUND',
      );
    });
  });

  test('nor does anybody once the workspace is deleted', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const id = await upload(world, world.owner, 'draft.txt', new Uint8Array([1]));
      await db
        .updateTable('workspaces')
        .set({ deleted_at: NOW })
        .where('id', '=', world.workspaceId)
        .execute();
      expect(await statusOf(world, `/api/attachments/${id}`, world.owner)).toBe(
        '404 ATTACHMENT_NOT_FOUND',
      );
    });
  });

  test('a deleted message’s attachments are nobody’s, though the rows stay', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const file = await upload(world, world.owner, 'notes.txt', new Uint8Array([1]));
      const message = await sendWith(world, world.publicChannel, [file]);
      expect((await world.call('DELETE', `/api/messages/${message}`, world.owner)).status).toBe(
        204,
      );
      for (const who of [world.owner, world.member]) {
        expect(await statusOf(world, `/api/attachments/${file}`, who)).toBe(
          '404 ATTACHMENT_NOT_FOUND',
        );
      }
    });
  });

  test('an SVG with a script is served as bytes to save, and can run nothing (#111)', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const svg = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>',
      );
      const id = await upload(world, world.owner, 'logo "evil".svg', svg);
      const response = await world.call('GET', `/api/attachments/${id}`, world.owner);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(svg);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="logo _evil_.svg"; filename*=UTF-8''${encodeURIComponent('logo "evil".svg')}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'private, no-cache',
      });
      // A file has no thumbnail.
      expect(await statusOf(world, `/api/attachments/${id}/thumbnail`, world.owner)).toBe(
        '404 ATTACHMENT_NOT_FOUND',
      );
    });
  });

  test("a name with ' ( ) * is encoded whole, so a strict parser reads it back as it was", async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const id = await upload(world, world.owner, "it's (1)*.pdf", new Uint8Array([1]));
      const response = await world.call('GET', `/api/attachments/${id}`, world.owner);
      const header = response.headers.get('content-disposition') ?? '';
      expect(header).toContain("filename*=UTF-8''it%27s%20%281%29%2A.pdf");
      expect(decodeURIComponent(header.split("filename*=UTF-8''")[1] ?? '')).toBe("it's (1)*.pdf");
    });
  });

  test('an image is drawn: inline, as the WebP it was stored as, and so is its thumbnail', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const id = await upload(world, world.owner, 'Ekran görüntüsü.png', twoColourPng(800, 400));
      const original = await world.call('GET', `/api/attachments/${id}`, world.owner);
      expect(original.headers.get('content-type')).toBe('image/webp');
      expect(original.headers.get('content-disposition')).toBe(
        `inline; filename="Ekran g_r_nt_s_.webp"; filename*=UTF-8''${encodeURIComponent('Ekran görüntüsü.webp')}`,
      );
      const thumbnail = await world.call('GET', `/api/attachments/${id}/thumbnail`, world.owner);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/webp');
      const size = await new Bun.Image(new Uint8Array(await thumbnail.arrayBuffer())).metadata();
      expect([size.width, size.height]).toEqual([512, 256]);
    });
  });

  test('a copy in the browser is asked about each time: unchanged is a 304, and nobody’s once access goes (D-231 §3)', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const id = await upload(world, world.owner, 'chart.png', twoColourPng(800, 400));
      await sendWith(world, world.publicChannel, [id]);
      for (const at of [`/api/attachments/${id}`, `/api/attachments/${id}/thumbnail`]) {
        const first = await world.call('GET', at, world.member);
        expect(first.status).toBe(200);
        expect(first.headers.get('cache-control')).toBe('private, no-cache');
        const etag = first.headers.get('etag') ?? '';
        expect(etag).toMatch(/^"[^"]+"$/);

        // Asked again with the copy's tag: nothing to send, and the store is not read for it.
        const again = await world.call('GET', at, world.member, undefined, {
          'if-none-match': etag,
        });
        expect([again.status, await again.text()]).toEqual([304, '']);
        expect(again.headers.get('etag')).toBe(etag);
        expect(again.headers.get('cache-control')).toBe('private, no-cache');
        // A tag of something else is answered whole.
        const other = await world.call('GET', at, world.member, undefined, {
          'if-none-match': '"something-else"',
        });
        expect(other.status).toBe(200);
      }
      const original = await world.call('GET', `/api/attachments/${id}`, world.member);
      const thumbnail = await world.call('GET', `/api/attachments/${id}/thumbnail`, world.member);
      expect(original.headers.get('etag')).not.toBe(thumbnail.headers.get('etag'));
      const etag = original.headers.get('etag') ?? '';

      // Removed from the workspace, the member's copy is refused when it is asked about.
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', world.workspaceId)
        .where('user_id', '=', world.member.userId)
        .execute();
      const removed = await world.call('GET', `/api/attachments/${id}`, world.member, undefined, {
        'if-none-match': etag,
      });
      expect(removed.status).toBe(404);
      // And signed out, it is asked for a session first.
      const signedOut = await world.call('GET', `/api/attachments/${id}`, null, undefined, {
        'if-none-match': etag,
      });
      expect(signedOut.status).toBe(401);
      // The owner's is still unchanged, without a read: the objects gone, the answer is still 304.
      for (const key of world.store.keys()) await world.store.delete(key);
      const unread = await world.call('GET', `/api/attachments/${id}`, world.owner, undefined, {
        'if-none-match': etag,
      });
      expect(unread.status).toBe(304);
    });
  });

  test('a row whose object is gone is the server’s failure, never “not found”', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const id = await upload(world, world.owner, 'notes.txt', new Uint8Array([1]));
      for (const key of world.store.keys()) await world.store.delete(key);
      expect(await statusOf(world, `/api/attachments/${id}`, world.owner)).toBe('500 INTERNAL');
    });
  });
});

describe('integration: throwing an upload away', () => {
  test('one’s own unsent upload goes, row and objects; anything else is 404 and stays', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const mine = await upload(world, world.owner, 'shot.png', twoColourPng(64, 64));
      const theirs = await upload(world, world.member, 'theirs.txt', new Uint8Array([1]));
      const sent = await upload(world, world.owner, 'sent.txt', new Uint8Array([2]));
      await sendWith(world, world.publicChannel, [sent]);
      const keysBefore = world.store.keys().length;

      const refuse = async (id: string): Promise<string> => {
        const response = await world.call('DELETE', `/api/attachments/${id}`, world.owner);
        return `${String(response.status)} ${((await response.json()) as { error: { code: string } }).error.code}`;
      };
      expect(await refuse(theirs)).toBe('404 ATTACHMENT_NOT_FOUND');
      expect(await refuse(sent)).toBe('404 ATTACHMENT_NOT_FOUND');
      expect(await refuse('nope')).toBe('404 ATTACHMENT_NOT_FOUND');
      expect(world.store.keys()).toHaveLength(keysBefore);

      expect((await world.call('DELETE', `/api/attachments/${mine}`, world.owner)).status).toBe(
        204,
      );
      // Its object and its thumbnail both.
      expect(world.store.keys()).toHaveLength(keysBefore - 2);
      const row = await db.selectFrom('attachments').select('id').where('id', '=', mine).execute();
      expect(row).toEqual([]);
      expect(await refuse(mine)).toBe('404 ATTACHMENT_NOT_FOUND');
    });
  });
});
