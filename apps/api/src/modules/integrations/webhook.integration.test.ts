/**
 * GitHub's delivery to a repository's feed (#79, D-134 §4–8), against the database: a signed push is
 * a message nobody wrote, unread for everybody and telling nobody, announced after it commits; the
 * same delivery again posts nothing; a ping learns the repository; and every refusal — no such feed,
 * a signature that does not hold, an archived channel, another repository, a body that is not the
 * event, a full bucket — writes no message, and the ones after the signature are said on the feed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import type { GitHubFeedEventName, ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { channelTopic, type EventBus } from '../../platform/events';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { createFeed } from './feeds';
import { receiveDelivery, type Delivery, type WebhookDependencies } from './webhook';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
const cipher = credentialCipher(Buffer.alloc(32, 3).toString('base64'));
const sha = (c: string): string => c.repeat(40);

const push = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repository: { id: 42, full_name: 'acme/api' },
  sender: { login: 'octocat' },
  ref: 'refs/heads/main',
  before: sha('a'),
  after: sha('b'),
  created: false,
  deleted: false,
  forced: false,
  commits: [{ id: sha('b'), message: 'Retry with jitter' }],
  ...over,
});

interface World {
  readonly room: Room;
  readonly feedId: string;
  readonly secret: string;
  readonly frames: [string, ServerFrame][];
  readonly lines: Record<string, unknown>[];
  readonly charged: string[];
  readonly deliver: (
    body: unknown,
    over?: Partial<Omit<Delivery, 'body'>> & { readonly raw?: Uint8Array },
  ) => Promise<string>;
}

const aWorld = async (
  db: Transaction,
  room?: Room,
  full = false,
  events: readonly GitHubFeedEventName[] = ['push'],
): Promise<World> => {
  const here = room ?? (await aRoom(db, ['alice', 'bob']));
  const alice = here.members['alice']?.context;
  if (alice === undefined) throw new Error('no alice');
  const made = await createFeed(db, clock, cipher, alice, {
    repository: 'Acme/API',
    events: [...events],
  });
  const frames: [string, ServerFrame][] = [];
  const bus: EventBus = {
    publish: (topic, frame) => {
      frames.push([topic, frame]);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  const { log, lines } = aRecordingLogger();
  const charged: string[] = [];
  const dependencies: WebhookDependencies = {
    database: db,
    clock,
    cipher,
    bus,
    log,
    mayDeliver: (feedId) => {
      charged.push(feedId);
      return Promise.resolve(!full);
    },
  };
  let n = 0;
  const deliver: World['deliver'] = async (body, over = {}) => {
    n += 1;
    const raw = over.raw ?? new TextEncoder().encode(JSON.stringify(body));
    return await receiveDelivery(dependencies, {
      feedId: made.feed.id,
      signature: `sha256=${createHmac('sha256', made.secret).update(raw).digest('hex')}`,
      event: 'push',
      deliveryId: `delivery-${String(n)}`,
      ...over,
      body: raw,
    }).then(
      (outcome) => outcome,
      (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
    );
  };
  return { room: here, feedId: made.feed.id, secret: made.secret, frames, lines, charged, deliver };
};

const eventsIn = async (db: Executor, channelId: string): Promise<number> =>
  (
    await db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', channelId)
      .where('message_type', '=', 'system_event')
      .execute()
  ).length;

const feedRow = async (
  db: Executor,
  feedId: string,
): Promise<{
  repository_id: string | null;
  repository_full_name: string;
  last_failure: string | null;
  last_delivery_at: Date | null;
}> =>
  await db
    .selectFrom('github_repo_feeds')
    .select(['repository_id', 'repository_full_name', 'last_failure', 'last_delivery_at'])
    .where('id', '=', feedId)
    .executeTakeFirstOrThrow();

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

describe('integration: a delivery to a feed', () => {
  test('a signed push is posted: nobody’s, unread for everybody, telling nobody, announced', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { room } = world;
      // Bob follows everything in the channel: an event still tells him nothing (D-134 §7).
      await db
        .updateTable('channel_members')
        .set({ notification_level: 'all' })
        .where('channel_id', '=', room.channelId)
        .execute();

      expect(await world.deliver(push())).toBe('posted');

      const [row] = await db
        .selectFrom('messages')
        .select(['id', 'sender_id', 'message_type', 'content'])
        .where('channel_id', '=', room.channelId)
        .execute();
      expect([row?.sender_id, row?.message_type]).toEqual([null, 'system_event']);
      expect(row?.content).toContain('octocat pushed branch main in acme/api');
      for (const name of ['alice', 'bob']) {
        expect((await counters(db, room, idOf(room, name))).unread).toBe(1);
        expect(await notificationsOf(db, idOf(room, name))).toEqual([]);
      }
      // The room hears the message, then each member their numbers.
      expect(world.frames.map(([, frame]) => frame.event)).toEqual([
        'MESSAGE_CREATED',
        'CHANNEL_STATE',
        'CHANNEL_STATE',
      ]);
      const [topic, created] = world.frames[0] ?? [];
      // The channel's topic: the room hears it as it hears a person's message, and nobody outside it.
      expect(topic).toBe(channelTopic(room.channelId));
      expect(created?.event === 'MESSAGE_CREATED' && created.data.githubEvent?.kind).toBe('push');
      expect(created?.event === 'MESSAGE_CREATED' && created.data.sender).toBeNull();

      const feed = await feedRow(db, world.feedId);
      expect([feed.repository_id, feed.last_failure, feed.last_delivery_at]).toEqual([
        '42',
        null,
        NOW,
      ]);
      const channel = await db
        .selectFrom('channels')
        .select('last_message_at')
        .where('id', '=', room.channelId)
        .executeTakeFirstOrThrow();
      expect(channel.last_message_at).toEqual(NOW);
      // One line for the delivery, and nothing of its body.
      const said = world.lines.filter((line) => line['msg'] === 'github delivery');
      expect(said.map((line) => line['outcome'])).toEqual(['posted']);
      expect(JSON.stringify(world.lines)).not.toContain('Retry with jitter');
    });
  });

  test('a merged pull request is posted to a feed that hears of them, and a push to it is not', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, undefined, false, ['pull_request', 'release']);
      const merged = {
        repository: { id: 42, full_name: 'acme/api' },
        sender: { login: 'octocat' },
        action: 'closed',
        number: 7,
        pull_request: { title: 'Retry with jitter', merged: true },
      };
      expect(await world.deliver(merged, { event: 'pull_request' })).toBe('posted');
      expect(await world.deliver(push())).toBe('ignored');
      const [created] = world.frames.map(([, frame]) => frame);
      expect(created?.event === 'MESSAGE_CREATED' && created.data.githubEvent).toEqual({
        kind: 'pull_request',
        repository: 'acme/api',
        actor: 'octocat',
        action: 'merged',
        number: 7,
        title: 'Retry with jitter',
      });
      expect(await eventsIn(db, world.room.channelId)).toBe(1);
    });
  });

  test('the same delivery again posts nothing and is told it was received', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(await world.deliver(push(), { deliveryId: 'redelivered' })).toBe('posted');
      expect(await world.deliver(push(), { deliveryId: 'redelivered' })).toBe('duplicate');
      expect(await eventsIn(db, world.room.channelId)).toBe(1);
      expect((await counters(db, world.room, idOf(world.room, 'bob'))).unread).toBe(1);
    });
  });

  test('a signed body sent again under a new delivery id is a replay: it posts nothing (D-231 §1)', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const raw = new TextEncoder().encode(JSON.stringify(push()));
      expect(await world.deliver(null, { raw, deliveryId: 'seen-once' })).toBe('posted');
      // The id is not signed: anybody who saw the delivery can make up another.
      expect(await world.deliver(null, { raw, deliveryId: 'made-up' })).toBe('duplicate');
      // A body that differs by a byte is another delivery, and posts.
      const next = new TextEncoder().encode(JSON.stringify(push({ after: sha('c') })));
      expect(await world.deliver(null, { raw: next, deliveryId: 'next' })).toBe('posted');
      expect(await eventsIn(db, world.room.channelId)).toBe(2);
      // The same bytes to another feed are that feed's delivery: each feed has its own secret.
      const other = await aWorld(db, await aRoom(db, ['alice']));
      expect(await other.deliver(null, { raw, deliveryId: 'seen-once' })).toBe('posted');
      const said = world.lines.filter((line) => line['msg'] === 'github delivery');
      expect(said.map((line) => line['outcome'])).toEqual(['posted', 'duplicate', 'posted']);
    });
  });

  test('a ping learns the repository and posts nothing; an event the feed does not post is ignored', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const ping = { repository: { id: 42, full_name: 'acme/api' }, sender: { login: 'octocat' } };
      expect(await world.deliver(ping, { event: 'ping' })).toBe('pinged');
      expect((await feedRow(db, world.feedId)).repository_id).toBe('42');
      expect(await world.deliver(ping, { event: 'issues' })).toBe('ignored');
      expect(await eventsIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('a renamed repository keeps its feed: matched by its number, its new name kept', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(await world.deliver(push())).toBe('posted');
      const renamed = push({ repository: { id: 42, full_name: 'Acme/Backend' } });
      expect(await world.deliver(renamed)).toBe('posted');
      expect((await feedRow(db, world.feedId)).repository_full_name).toBe('acme/backend');
      // Another repository with the old name is not this one.
      const impostor = push({ repository: { id: 7, full_name: 'acme/api' } });
      expect(await world.deliver(impostor)).toBe('GITHUB_REPOSITORY_MISMATCH');
      expect((await feedRow(db, world.feedId)).last_failure).toBe('repository_mismatch');
      expect(await eventsIn(db, world.room.channelId)).toBe(2);
    });
  });

  test('a rename onto a name another feed of the channel holds keeps both feeds posting', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const alice = world.room.members['alice']?.context;
      if (alice === undefined) throw new Error('no alice');
      await createFeed(db, clock, cipher, alice, { repository: 'acme/old', events: ['push'] });
      expect(await world.deliver(push())).toBe('posted');
      // acme/api, repository 42, is renamed to the name the other feed holds.
      const renamed = push({ repository: { id: 42, full_name: 'acme/old' } });
      expect(await world.deliver(renamed)).toBe('posted');
      expect(await world.deliver(renamed, { event: 'ping' })).toBe('pinged');
      expect((await feedRow(db, world.feedId)).repository_full_name).toBe('acme/api');
      expect(await eventsIn(db, world.room.channelId)).toBe(2);
    });
  });

  test('a deleted workspace’s feeds are not there', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await db
        .updateTable('workspaces')
        .set({ deleted_at: NOW })
        .where('id', '=', world.room.workspaceId)
        .execute();
      expect(await world.deliver(push())).toBe('GITHUB_FEED_NOT_FOUND');
      expect(await eventsIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('an organisation’s ping names no repository: received, and nothing failed', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        await world.deliver({ zen: 'Design for failure.', hook_id: 1 }, { event: 'ping' }),
      ).toBe('pinged');
      expect(await feedRow(db, world.feedId)).toMatchObject({
        repository_id: null,
        last_failure: null,
        last_delivery_at: NOW,
      });
    });
  });

  test('before its number is known, another repository by name is refused and said', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const other = push({ repository: { id: 9, full_name: 'acme/web' } });
      expect(await world.deliver(other)).toBe('GITHUB_REPOSITORY_MISMATCH');
      expect(await feedRow(db, world.feedId)).toMatchObject({
        repository_id: null,
        last_failure: 'repository_mismatch',
      });
    });
  });

  test('a signature that does not hold writes nothing — not even on the feed — and spends no bucket', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const signature of [null, 'sha256=00', `sha256=${'0'.repeat(64)}`]) {
        expect(await world.deliver(push(), { signature })).toBe('WEBHOOK_SIGNATURE_INVALID');
      }
      // The body is changed after it was signed: the signature is over the bytes as sent.
      const signed = new TextEncoder().encode(JSON.stringify(push()));
      const signature = `sha256=${createHmac('sha256', world.secret).update(signed).digest('hex')}`;
      const altered = new TextEncoder().encode(JSON.stringify(push({ ref: 'refs/heads/evil' })));
      expect(await world.deliver(null, { raw: altered, signature })).toBe(
        'WEBHOOK_SIGNATURE_INVALID',
      );
      expect(await eventsIn(db, world.room.channelId)).toBe(0);
      expect(await feedRow(db, world.feedId)).toMatchObject({
        last_delivery_at: null,
        last_failure: null,
      });
      expect(world.charged).toEqual([]);
    });
  });

  test('another feed’s secret does not post into this one', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const elsewhere = await aWorld(db, await aRoom(db, ['alice']));
      const raw = new TextEncoder().encode(JSON.stringify(push()));
      const theirs = `sha256=${createHmac('sha256', elsewhere.secret).update(raw).digest('hex')}`;
      expect(await world.deliver(null, { raw, signature: theirs })).toBe(
        'WEBHOOK_SIGNATURE_INVALID',
      );
      expect(await eventsIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('no such feed, or not an id at all, is not found', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(await world.deliver(push(), { feedId: crypto.randomUUID() })).toBe(
        'GITHUB_FEED_NOT_FOUND',
      );
      expect(await world.deliver(push(), { feedId: 'not-a-uuid' })).toBe('GITHUB_FEED_NOT_FOUND');
    });
  });

  test('an archived channel’s feed posts nowhere, and says why', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await db
        .updateTable('channels')
        .set({ deleted_at: NOW })
        .where('id', '=', world.room.channelId)
        .execute();
      expect(await world.deliver(push())).toBe('GITHUB_FEED_NOT_FOUND');
      expect((await feedRow(db, world.feedId)).last_failure).toBe('channel_archived');
      expect(await eventsIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('signed, but not the event: refused and said, nothing posted', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(await world.deliver(null, { raw: new TextEncoder().encode('not json') })).toBe(
        'VALIDATION_FAILED',
      );
      expect(await world.deliver(push({ before: 'abc' }))).toBe('VALIDATION_FAILED');
      expect((await feedRow(db, world.feedId)).last_failure).toBe('payload_invalid');
      expect(await eventsIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('a delivery that does not name its event and its id is refused, and nothing is written', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const over of [
        { event: null },
        { deliveryId: null },
        { deliveryId: 'x'.repeat(65) },
        { event: 'Push; drop' },
      ]) {
        expect(await world.deliver(push(), over)).toBe('VALIDATION_FAILED');
      }
      expect(await feedRow(db, world.feedId)).toMatchObject({ last_delivery_at: null });
    });
  });

  test('a feed past its bucket is refused once its signature held, and posts nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, undefined, true);
      expect(await world.deliver(push())).toBe('RATE_LIMITED');
      expect(world.charged).toEqual([world.feedId]);
      expect(await eventsIn(db, world.room.channelId)).toBe(0);
      // GitHub will not send it again on its own: the feed says it was lost.
      expect((await feedRow(db, world.feedId)).last_failure).toBe('rate_limited');
    });
  });

  test('a secret that no longer opens is the operator’s to hear about, and posts nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await db
        .updateTable('github_repo_feeds')
        .set({ secret_encrypted: Buffer.from('garbage').toString('base64') })
        .where('id', '=', world.feedId)
        .execute();
      expect(await world.deliver(push())).toBe('INTERNAL');
      expect(
        world.lines.some((line) => line['level'] === 'error' && line['feedId'] === world.feedId),
      ).toBe(true);
    });
  });
});
