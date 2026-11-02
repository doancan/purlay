/**
 * Incoming webhooks through HTTP (D-245): an admin makes one — a `201` the contract parses, with a path
 * whose last segment is the secret — and a tool posts to it with no cookie, as `curl` would: `201` and the
 * message's id, which another member then reads in the channel by the hook's name. A body the contract
 * refuses is a `400`, one past the JSON bound a `413` before it is read, a form a `415`; a wrong secret is
 * the same bytes as an id nobody made; past the hook's bucket is a `429`. And the secret is in no line of
 * the log, whatever the request came to.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import {
  CreatedIncomingWebhook,
  IncomingWebhookAnswer,
  IncomingWebhookList,
  MESSAGE_CONTENT_MAX,
  MessagePage,
} from '@purlay/types';
import { SESSION_COOKIE } from '../../platform/cookies';
import { fixedClock } from '../../platform/clock';
import { aSession } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { aRecordingLogger, testDependencies } from '../../testing/doubles';
import { createApp } from './app';
import { JSON_BODY_MAX_BYTES } from './edge';
import { INCOMING_WEBHOOK_BUDGET } from './rate-limit';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-11-01T12:00:00.000Z');
const clock = fixedClock(NOW);

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

interface World {
  readonly app: ReturnType<typeof createApp>;
  readonly lines: Record<string, unknown>[];
  readonly channelId: string;
  /** Alice, the owner. */
  readonly admin: Call;
  /** Bob, a member of the channel. */
  readonly member: Call;
  /** A request with no cookie, as a tool sends it. */
  readonly anonymous: Call;
}

const aWorld = async (db: Executor): Promise<World> => {
  const room = await aRoom(db, ['alice', 'bob']);
  const { log, lines } = aRecordingLogger();
  const app = createApp(testDependencies({ database: db, clock, log }));
  const as =
    (token: string | null): Call =>
    async (method, path, body) =>
      await app.handle(
        new Request(`https://purlay.test${path}`, {
          method,
          headers: {
            ...(token === null ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined
            ? {}
            : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        }),
      );
  const alice = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
  const bob = await aSession(db, clock, room.members['bob']?.userId ?? '', 30);
  return {
    app,
    lines,
    channelId: room.channelId,
    admin: as(alice.token),
    member: as(bob.token),
    anonymous: as(null),
  };
};

const made = async (world: World): Promise<CreatedIncomingWebhook> => {
  const response = await world.admin('POST', `/api/channels/${world.channelId}/incoming-webhooks`, {
    name: 'CI',
  });
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (!Value.Check(CreatedIncomingWebhook, body)) throw new Error('not the contract');
  return body;
};

const codeOf = async (response: Response): Promise<[number, string]> => [
  response.status,
  ((await response.json()) as { error: { code: string } }).error.code,
];

describe('integration: incoming webhooks over HTTP', () => {
  test('made, posted to with no cookie, and read by another member under the hook’s name', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const created = await made(world);

      const listed = await world.admin('GET', `/api/channels/${world.channelId}/incoming-webhooks`);
      const list: unknown = await listed.json();
      expect(Value.Check(IncomingWebhookList, list)).toBe(true);
      expect(list).toEqual([created.webhook]);

      const posted = await world.anonymous('POST', created.path, { text: 'Deploy **finished**' });
      expect(posted.status).toBe(201);
      const answer: unknown = await posted.json();
      if (!Value.Check(IncomingWebhookAnswer, answer)) throw new Error('not the contract');

      const page = await world.member('GET', `/api/channels/${world.channelId}/messages`);
      const read: unknown = await page.json();
      if (!Value.Check(MessagePage, read)) throw new Error('not a page');
      expect(read.data).toHaveLength(1);
      expect(read.data[0]).toMatchObject({
        id: answer.messageId,
        sender: null,
        githubEvent: null,
        incomingWebhook: { name: 'CI' },
        content: 'Deploy **finished**',
      });

      const after = (await (
        await world.admin('GET', `/api/channels/${world.channelId}/incoming-webhooks`)
      ).json()) as { lastUsedAt: string | null }[];
      expect(after[0]?.lastUsedAt).toBe(NOW.toISOString());

      expect(
        (
          await world.admin(
            'DELETE',
            `/api/channels/${world.channelId}/incoming-webhooks/${created.webhook.id}`,
          )
        ).status,
      ).toBe(204);
      expect(await codeOf(await world.anonymous('POST', created.path, { text: 'again' }))).toEqual([
        404,
        'INCOMING_WEBHOOK_NOT_FOUND',
      ]);
    });
  });

  test('managing needs a session: no cookie is a 401 for each', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const path = `/api/channels/${world.channelId}/incoming-webhooks`;
      expect((await world.anonymous('GET', path)).status).toBe(401);
      expect((await world.anonymous('POST', path, { name: 'CI' })).status).toBe(401);
      expect((await world.anonymous('DELETE', `${path}/${crypto.randomUUID()}`)).status).toBe(401);
    });
  });

  test('a name the contract refuses is a 400 and makes nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const path = `/api/channels/${world.channelId}/incoming-webhooks`;
      for (const body of [
        {},
        { name: '' },
        { name: 'x'.repeat(81) },
        { name: 'a‮b' },
        { name: 'CI', extra: 1 },
      ]) {
        expect(await codeOf(await world.admin('POST', path, body))).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
      }
      expect((await world.admin('POST', path, { name: 'Ç'.repeat(80) })).status).toBe(201);
      const rows = await db
        .selectFrom('incoming_webhooks')
        .select('name')
        .where('channel_id', '=', world.channelId)
        .execute();
      expect(rows).toEqual([{ name: 'Ç'.repeat(80) }]);
    });
  });

  test('a body the contract refuses is a 400, past the JSON bound a 413, a form a 415: none posts', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { path } = await made(world);
      for (const body of [
        {},
        { text: '' },
        { text: 42 },
        { text: 'x'.repeat(MESSAGE_CONTENT_MAX + 1) },
        // Slack's other fields are refused, not dropped: a block nobody draws is a message nobody reads.
        { text: 'ok', blocks: [] },
        { text: 'ok', username: 'Grafana' },
        ['text'],
      ]) {
        expect(await codeOf(await world.anonymous('POST', path, body))).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
      }
      expect((await world.anonymous('POST', path, '{"text": ')).status).toBe(400);
      // Measured by its length before a byte is read, as the edge does for every JSON route.
      const huge = JSON.stringify({ text: 'x'.repeat(JSON_BODY_MAX_BYTES) });
      const tooLarge = await world.app.handle(
        new Request(`https://purlay.test${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(new TextEncoder().encode(huge).byteLength),
          },
          body: huge,
        }),
      );
      expect(await codeOf(tooLarge)).toEqual([413, 'PAYLOAD_TOO_LARGE']);
      const form = await world.app.handle(
        new Request(`https://purlay.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'text=hello',
        }),
      );
      expect(await codeOf(form)).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
      const none = await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', world.channelId)
        .execute();
      expect(none).toEqual([]);

      // Exactly at the bound is a message.
      expect(
        (await world.anonymous('POST', path, { text: 'ş'.repeat(MESSAGE_CONTENT_MAX) })).status,
      ).toBe(201);
    });
  });

  test('a wrong secret is the same answer as an id nobody made, byte for byte', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { path, webhook } = await made(world);
      const wrong = path.replace(/[0-9a-f]$/, (last) => (last === '0' ? '1' : '0'));
      const nobody = path.replace(webhook.id, crypto.randomUUID());
      const answers = await Promise.all(
        [wrong, nobody, `/api/webhooks/incoming/not-a-uuid/${'0'.repeat(64)}`].map(async (each) => {
          const response = await world.anonymous('POST', each, { text: 'x' });
          const body = (await response.json()) as { error: Record<string, unknown> };
          return { status: response.status, error: { ...body.error, requestId: undefined } };
        }),
      );
      expect(answers[0]?.status).toBe(404);
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
    });
  });

  test('past the hook’s bucket a post is a 429, and the hook’s bucket is its own', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { path } = await made(world);
      for (let n = 0; n < INCOMING_WEBHOOK_BUDGET.burst; n += 1) {
        expect((await world.anonymous('POST', path, { text: `n${String(n)}` })).status).toBe(201);
      }
      expect(await codeOf(await world.anonymous('POST', path, { text: 'one more' }))).toEqual([
        429,
        'RATE_LIMITED',
      ]);
      // Another hook of the channel still posts.
      const other = await made(world);
      expect((await world.anonymous('POST', other.path, { text: 'other' })).status).toBe(201);
    });
  });

  test('the secret is in no line of the log: posted, refused at the edge, not found, or invalid', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { path, webhook } = await made(world);
      const secret = path.slice(path.lastIndexOf('/') + 1);
      await world.anonymous('POST', path, { text: 'posted' });
      await world.anonymous('POST', `${path}/`, { text: 'a trailing slash' });
      await world.anonymous('POST', `/api//webhooks/incoming/${webhook.id}//${secret}`, {
        text: 'doubled slashes',
      });
      await world.anonymous('POST', path, { nope: true });
      const huge = JSON.stringify({ text: 'x'.repeat(JSON_BODY_MAX_BYTES) });
      // Turned away at the edge, before any route: written by the edge's own line.
      await world.app.handle(
        new Request(`https://purlay.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(huge.length) },
          body: huge,
        }),
      );
      await world.anonymous('POST', path.replace(webhook.id, crypto.randomUUID()), { text: 'x' });

      const requests = world.lines.filter((line) => line['msg'] === 'request');
      expect(requests.length).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(world.lines)).not.toContain(secret);
      expect(requests.map((line) => line['path'])).toContain(
        `/api/webhooks/incoming/${webhook.id}/:secret`,
      );
    });
  });
});
