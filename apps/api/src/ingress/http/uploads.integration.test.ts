/**
 * `POST /api/workspaces/:workspaceId/uploads` through the HTTP surface (D-109 §3, §4): the one route
 * whose body is not JSON — what it takes, what it refuses, and that nothing is read for somebody it
 * does not let in. The rules of storing are the module's (`uploads.integration.test.ts`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { ATTACHMENT_BYTES_MAX, Attachment, messageId } from '@purlay/types';
import { createApp } from './app';
import { UPLOADS_AT_ONCE, receiveUpload } from './uploads';
import { AppError } from '../../platform/errors';
import { atomicallyOn } from '../../platform/transactions';
import { NOW, aRecordingLogger, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aTestAuth, aSignedInUser } from '../../testing/signed-in';
import { claimingPng, twoColourPng } from '../../testing/png';
import { aMemoryStore } from '../../testing/storage';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() + (tick += 1)));

const send = async (
  db: Executor,
  path: string,
  init: {
    cookie?: string;
    type?: string | null;
    body?: Uint8Array | ReadableStream<Uint8Array> | null;
    length?: string | null;
  },
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  const type = init.type === undefined ? 'application/octet-stream' : init.type;
  if (type !== null) headers['content-type'] = type;
  const body = init.body === undefined ? new Uint8Array([1, 2, 3]) : init.body;
  const length =
    init.length === undefined
      ? body instanceof Uint8Array
        ? String(body.length)
        : null
      : init.length;
  if (length !== null) headers['content-length'] = length;
  return await createApp(testDependencies({ database: db, clock, storage: aMemoryStore() })).handle(
    new Request(`https://purlay.test${path}`, {
      method: 'POST',
      headers,
      ...(body === null ? {} : { body }),
    }),
  );
};

const aWorkspace = async (db: Executor): Promise<{ cookie: string; workspaceId: string }> => {
  const { cookie } = await aSignedInUser(db, clock, 'up-alice');
  const created = await createApp(testDependencies({ database: db, clock })).handle(
    new Request('https://purlay.test/api/workspaces', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'up', slug: aUniqueSlug('up') }),
    }),
  );
  return { cookie, workspaceId: ((await created.json()) as { id: string }).id };
};

const code = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('integration: the upload door', () => {
  test('raw bytes in, an attachment out: 201, then the same upload again is 200 and the same', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const id = anId();
      const path = `/api/workspaces/${workspaceId}/uploads?id=${id}&name=${encodeURIComponent('a b.txt')}`;
      const first = await send(db, path, { cookie });
      expect(first.status).toBe(201);
      const body: unknown = await first.json();
      expect(Value.Check(Attachment, body)).toBe(true);
      expect(body).toMatchObject({ id, fileName: 'a b.txt', sizeBytes: 3 });
      const again = await send(db, path, { cookie });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(body);
    });
  });

  test('an image is answered as one, measured; a broken one is 400 IMAGE_UNREADABLE, a bomb 413', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const path = (): string => `/api/workspaces/${workspaceId}/uploads?id=${anId()}&name=a.png`;
      const image = await send(db, path(), { cookie, body: twoColourPng(300, 150) });
      expect(image.status).toBe(201);
      expect(await image.json()).toMatchObject({
        kind: 'image',
        mimeType: 'image/webp',
        width: 300,
        height: 150,
      });
      const broken = await send(db, path(), {
        cookie,
        body: twoColourPng(300, 150).subarray(0, 60),
      });
      expect([broken.status, await code(broken)]).toEqual([400, 'IMAGE_UNREADABLE']);
      const bomb = await send(db, path(), { cookie, body: claimingPng(20_000, 20_000) });
      expect([bomb.status, await code(bomb)]).toEqual([413, 'IMAGE_TOO_LARGE']);
    });
  });

  test('a form, JSON, plain text or no type is 415: this route takes bytes, a form cannot send them', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const path = `/api/workspaces/${workspaceId}/uploads?id=${anId()}&name=a`;
      for (const type of [
        'multipart/form-data; boundary=x',
        'application/x-www-form-urlencoded',
        'text/plain',
        'application/json',
        null,
      ]) {
        const refused = await send(db, path, { cookie, type });
        expect({ type, status: refused.status }).toEqual({ type, status: 415 });
      }
    });
  });

  test('no length is 411; over the size limit is 413; both before anything is read', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const path = `/api/workspaces/${workspaceId}/uploads?id=${anId()}&name=a`;
      const unread = (): ReadableStream<Uint8Array> =>
        new ReadableStream({
          pull(): void {
            throw new Error('the body was read');
          },
        });
      const noLength = await send(db, path, { cookie, body: unread(), length: null });
      expect(noLength.status).toBe(411);
      const over = await send(db, path, {
        cookie,
        body: unread(),
        length: String(ATTACHMENT_BYTES_MAX + 1),
      });
      expect(over.status).toBe(413);
      expect(await code(over)).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  test('without a session, or in a workspace that is not yours, the body is never read', async () => {
    await withRollback(async (db) => {
      const { workspaceId } = await aWorkspace(db);
      const stranger = await aSignedInUser(db, clock, 'up-stranger');
      const path = `/api/workspaces/${workspaceId}/uploads?id=${anId()}&name=a`;
      const unread = new ReadableStream<Uint8Array>({
        pull(): void {
          throw new Error('the body was read');
        },
      });
      const anonymous = await send(db, path, { body: unread, length: '3' });
      expect(anonymous.status).toBe(401);
      const outsider = await send(db, path, {
        cookie: stranger.cookie,
        body: new ReadableStream<Uint8Array>({
          pull(): void {
            throw new Error('the body was read');
          },
        }),
        length: '3',
      });
      expect(outsider.status).toBe(404);
      expect(await code(outsider)).toBe('WORKSPACE_NOT_FOUND');
    });
  });

  test('a name that is missing, too long or carries control characters, or an unknown key, is 400', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const base = `/api/workspaces/${workspaceId}/uploads?id=${anId()}`;
      for (const query of [
        '',
        `&name=${'n'.repeat(256)}`,
        `&name=${encodeURIComponent('a‮b')}`,
        `&name=${encodeURIComponent('a\u0000b')}`,
        '&name=a&extra=1',
      ]) {
        const refused = await send(db, `${base}${query}`, { cookie });
        expect({ query, status: refused.status }).toEqual({ query, status: 400 });
      }
    });
  });

  test('every other route still refuses a body that is not JSON, and over 64 KiB', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      // Not the upload route: a trailing slash, another verb's path, an encoded segment.
      for (const path of [
        `/api/workspaces/${workspaceId}/uploads/`,
        `/api/workspaces/${workspaceId}/channels`,
        `/api/workspaces/${workspaceId}%2Fuploads`,
      ]) {
        const refused = await send(db, path, { cookie });
        expect({ path, status: refused.status }).toEqual({ path, status: 415 });
      }
    });
  });

  test('a node reading as many uploads as it may refuses the next with 429, before reading it', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const request = new Request(
        `https://purlay.test/api/workspaces/${workspaceId}/uploads?id=${anId()}&name=a`,
        {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': '3' },
          body: new ReadableStream<Uint8Array>({
            pull(): void {
              throw new Error('the body was read');
            },
          }),
        },
      );
      let refused = '';
      await receiveUpload(
        {
          auth: aTestAuth(db),
          database: db,
          clock,
          atomically: atomicallyOn(db),
          storage: aMemoryStore(),
          log: aRecordingLogger().log,
          inFlight: { count: UPLOADS_AT_ONCE },
        },
        request,
        workspaceId,
      ).catch((error: unknown) => {
        refused = error instanceof AppError ? error.body.code : String(error);
      });
      expect(refused).toBe('RATE_LIMITED');
    });
  });
});
