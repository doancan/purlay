/**
 * GitHub's delivery through HTTP (#79, D-134 §4): an admin connects a feed and GitHub posts to the
 * address it was given, with the secret it was given — `201` and a `WebhookAnswer`. The edge judges
 * the body before a byte is read: GitHub's default form type, no length, and one byte past the bound
 * are refused; exactly at the bound is read. Nobody is signed in, and no cookie is needed. What is
 * refused before a byte is read is `webhooks.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { CreatedGitHubFeed, WebhookAnswer } from '@purlay/types';
import { SESSION_COOKIE } from '../../platform/cookies';
import { fixedClock } from '../../platform/clock';
import { aSession } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { testConfig, testDependencies } from '../../testing/doubles';
import { credentialCipher } from '../../platform/crypto';
import { createApp } from './app';
import { WEBHOOK_BODY_MAX_BYTES } from './edge';
import { DELIVERIES_AT_ONCE, receiveWebhook } from './webhooks';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

const PUSH = {
  repository: { id: 42, full_name: 'acme/api' },
  sender: { login: 'octocat' },
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  created: false,
  deleted: false,
  forced: false,
  commits: [{ id: 'b'.repeat(40), message: 'Retry with jitter' }],
};

const connected = async (
  db: Transaction,
): Promise<{
  app: ReturnType<typeof createApp>;
  path: string;
  secret: string;
  channelId: string;
}> => {
  const room = await aRoom(db, ['alice']);
  const { token } = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
  const app = createApp(testDependencies({ database: db, clock }));
  const made = await app.handle(
    new Request(`https://purlay.test/api/channels/${room.channelId}/github-feeds`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repository: 'acme/api', events: ['push'] }),
    }),
  );
  const created: unknown = await made.json();
  if (!Value.Check(CreatedGitHubFeed, created)) throw new Error('not connected');
  return { app, path: created.webhookPath, secret: created.secret, channelId: room.channelId };
};

const signed = (secret: string, raw: Uint8Array): string =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

const post = (
  path: string,
  raw: Uint8Array,
  headers: Record<string, string>,
  length = true,
): Request =>
  new Request(`https://purlay.test${path}`, {
    method: 'POST',
    headers: {
      'x-github-event': 'push',
      'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      ...(length ? { 'content-length': String(raw.byteLength) } : {}),
      ...headers,
    },
    body: raw,
  });

describe('integration: a delivery over HTTP', () => {
  test('signed with the secret it was given, a push is posted: 201 and the contract’s answer', async () => {
    await withRollback(async (db) => {
      const { app, path, secret, channelId } = await connected(db);
      const raw = new TextEncoder().encode(JSON.stringify(PUSH));
      const answer = await app.handle(
        post(path, raw, {
          'content-type': 'application/json',
          'x-hub-signature-256': signed(secret, raw),
        }),
      );
      expect(answer.status).toBe(201);
      const body: unknown = await answer.json();
      expect(Value.Check(WebhookAnswer, body)).toBe(true);
      expect(body).toEqual({ outcome: 'posted' });
      const events = await db
        .selectFrom('messages')
        .select('message_type')
        .where('channel_id', '=', channelId)
        .execute();
      expect(events).toEqual([{ message_type: 'system_event' }]);

      const again = await app.handle(
        post(path, raw, {
          'content-type': 'application/json',
          'x-hub-signature-256': signed(secret, raw),
        }),
      );
      expect([again.status, await again.json()]).toEqual([200, { outcome: 'duplicate' }]);
    });
  });

  test('the edge refuses GitHub’s default form, a body with no length, and one byte past the bound', async () => {
    await withRollback(async (db) => {
      const { app, path, secret } = await connected(db);
      const raw = new TextEncoder().encode(JSON.stringify(PUSH));
      const form = await app.handle(
        post(path, raw, {
          'content-type': 'application/x-www-form-urlencoded',
          'x-hub-signature-256': signed(secret, raw),
        }),
      );
      expect([
        form.status,
        ((await form.json()) as { error: { code: string } }).error.code,
      ]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
      const unmeasured = await app.handle(
        post(path, raw, { 'content-type': 'application/json' }, false),
      );
      expect(unmeasured.status).toBe(411);

      // Exactly at the bound is read — and is not the event, so it is a 400 from the service, not
      // the edge's 413; one byte more is refused before it is read.
      const at = new Uint8Array(WEBHOOK_BODY_MAX_BYTES).fill(0x20);
      const atBound = await app.handle(
        post(path, at, {
          'content-type': 'application/json',
          'x-hub-signature-256': signed(secret, at),
        }),
      );
      expect(atBound.status).toBe(400);
      const past = new Uint8Array(WEBHOOK_BODY_MAX_BYTES + 1).fill(0x20);
      const pastBound = await app.handle(
        post(path, past, {
          'content-type': 'application/json',
          'x-hub-signature-256': signed(secret, past),
        }),
      );
      expect(pastBound.status).toBe(413);
    });
  });

  test('a JSON route keeps the client’s bound: the webhook’s is its own path’s alone', async () => {
    await withRollback(async (db) => {
      const { app } = await connected(db);
      const big = new Uint8Array(70 * 1024).fill(0x20);
      const answer = await app.handle(
        post('/api/webhooks/github/x/y', big, { 'content-type': 'application/json' }),
      );
      expect(answer.status).toBe(413);
    });
  });
});

describe('integration: reading a delivery', () => {
  const PATH_FEED = /\/api\/webhooks\/github\/(.+)$/;

  const reading = async (
    db: Transaction,
    gate: { count: number },
    body: () => Promise<ArrayBuffer>,
  ): Promise<{ code: string; read: boolean }> => {
    const { path } = await connected(db);
    const feedId = PATH_FEED.exec(path)?.[1] ?? '';
    let read = false;
    const request = {
      arrayBuffer: () => {
        read = true;
        return body();
      },
      headers: new Headers(),
    } as unknown as Request;
    const code = await receiveWebhook(
      {
        ...testDependencies({ database: db, clock }),
        cipher: credentialCipher(testConfig().ENCRYPTION_KEY),
        bus: {
          publish: () => Promise.resolve(),
          subscribe: () => false,
          unsubscribe: () => undefined,
          forget: () => undefined,
        },
        mayDeliver: () => Promise.resolve(true),
        mayKnock: () => Promise.resolve(true),
        inFlight: gate,
        // The deadline passes at once: a body not already in is too slow.
        deadline: () => Promise.resolve(),
      },
      request,
      feedId,
      '203.0.113.7',
    ).then(
      () => 'accepted',
      (error: unknown) =>
        error !== null && typeof error === 'object' && 'body' in error
          ? (error as { body: { code: string } }).body.code
          : String(error),
    );
    return { code, read };
  };

  test('this node reads a few at a time: past them, nothing is read', async () => {
    await withRollback(async (db) => {
      const gate = { count: DELIVERIES_AT_ONCE };
      expect(await reading(db, gate, () => Promise.resolve(new ArrayBuffer(0)))).toEqual({
        code: 'RATE_LIMITED',
        read: false,
      });
      expect(gate.count).toBe(DELIVERIES_AT_ONCE);
    });
  });

  test('a body that does not arrive by the deadline is refused, and its place given back', async () => {
    await withRollback(async (db) => {
      const gate = { count: 0 };
      const never = (): Promise<ArrayBuffer> => new Promise<ArrayBuffer>(() => undefined);
      expect(await reading(db, gate, never)).toEqual({ code: 'RATE_LIMITED', read: true });
      expect(gate.count).toBe(0);
    });
  });
});
