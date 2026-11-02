/**
 * A channel's incoming webhooks (D-245), against the database: made by an owner or an admin, its secret
 * handed back once and only its digest kept, never in the list, the row or the trail; no more than the cap;
 * revoked only in its own channel. A post with the secret is a root message nobody wrote, by the hook's
 * name, unread for everybody and telling nobody, announced after it commits; every refusal — no such hook,
 * a wrong secret, a hook revoked, an archived channel, a deleted workspace, a full bucket — is the one
 * `404` (or the bucket's `429`) and writes no message.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { INCOMING_WEBHOOKS_PER_CHANNEL_MAX, type ServerFrame } from '@purlay/types';
import type { ChannelContext } from '../../platform/channels';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { channelTopic, type EventBus } from '../../platform/events';
import { tokenDigest } from '../../platform/tokens';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { readBuilt } from '../messages/reader';
import {
  channelWebhooks,
  createWebhook,
  receivePost,
  revokeWebhook,
  type IncomingPostDependencies,
} from './incoming-webhooks';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-11-01T12:00:00.000Z');
const clock = fixedClock(NOW);

const contextOf = (room: Room, name: string): ChannelContext => {
  const context = room.members[name]?.context;
  if (context === undefined) throw new Error(`no ${name}`);
  return context;
};

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('it was not refused');
};

/** The id and the secret of a path the answer carried. */
const partsOf = (path: string): { webhookId: string; secret: string } => {
  const match = /^\/api\/webhooks\/incoming\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(path);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new Error(`not a hook path: ${path}`);
  return { webhookId: match[1], secret: match[2] };
};

const messagesIn = async (db: Executor, channelId: string): Promise<number> =>
  (await db.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute())
    .length;

interface World {
  readonly room: Room;
  readonly webhookId: string;
  readonly secret: string;
  readonly frames: [string, ServerFrame][];
  readonly lines: Record<string, unknown>[];
  readonly charged: string[];
  readonly post: (text: string, over?: { webhookId?: string; secret?: string }) => Promise<string>;
}

const aWorld = async (db: Transaction, full = false): Promise<World> => {
  const room = await aRoom(db, ['alice', 'bob']);
  const made = await createWebhook(db, clock, contextOf(room, 'alice'), { name: 'CI' });
  const { webhookId, secret } = partsOf(made.path);
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
  const dependencies: IncomingPostDependencies = {
    database: db,
    clock,
    bus,
    log,
    mayPost: (id) => {
      charged.push(id);
      return Promise.resolve(!full);
    },
  };
  const post: World['post'] = async (text, over = {}) =>
    await receivePost(dependencies, { webhookId, secret, text, ...over }).then(
      (id) => id,
      (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
    );
  return { room, webhookId, secret, frames, lines, charged, post };
};

describe('integration: a channel’s incoming webhooks', () => {
  test('made: the hook, and a path whose secret is kept only as its digest, nowhere in the list or the trail', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const made = await createWebhook(db, clock, alice, { name: 'CI' });
      const { webhookId, secret } = partsOf(made.path);

      expect(made.webhook).toEqual({
        id: webhookId,
        channelId: room.channelId,
        name: 'CI',
        createdBy: {
          id: alice.userId,
          username: room.members['alice']?.username ?? '',
          displayName: 'alice',
          avatarUrl: null,
        },
        createdAt: NOW.toISOString(),
        lastUsedAt: null,
      });

      const row = await db
        .selectFrom('incoming_webhooks')
        .selectAll()
        .where('id', '=', webhookId)
        .executeTakeFirstOrThrow();
      expect(row.secret_digest).toBe(await tokenDigest(secret));
      expect(JSON.stringify(row)).not.toContain(secret);
      expect([row.workspace_id, row.created_by]).toEqual([room.workspaceId, alice.userId]);

      expect(await channelWebhooks(db, alice)).toEqual([made.webhook]);
      expect(JSON.stringify(await channelWebhooks(db, alice))).not.toContain(secret);

      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'target_id', 'metadata'])
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(trail).toEqual([
        {
          action: 'integration.webhook_created',
          target_id: webhookId,
          metadata: { name: 'CI', channelId: room.channelId },
        },
      ]);
      expect(JSON.stringify(trail)).not.toContain(secret);
    });
  });

  test('each hook has its own secret; two of one name are two hooks', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const first = await createWebhook(db, clock, alice, { name: 'CI' });
      const second = await createWebhook(db, clock, alice, { name: 'CI' });
      expect(partsOf(second.path).secret).not.toBe(partsOf(first.path).secret);
      // Another channel's hook is never in this channel's list.
      const elsewhere = await aRoom(db, ['carol']);
      await createWebhook(db, clock, contextOf(elsewhere, 'carol'), { name: 'CI' });
      expect((await channelWebhooks(db, alice)).map((hook) => hook.id)).toEqual(
        [first.webhook.id, second.webhook.id].sort(),
      );
    });
  });

  test('a member is refused making, listing and revoking; an admin may; a direct message has none', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = contextOf(room, 'bob');
      expect(await refusal(createWebhook(db, clock, bob, { name: 'CI' }))).toBe('FORBIDDEN');
      expect(await refusal(channelWebhooks(db, bob))).toBe('FORBIDDEN');
      const made = await createWebhook(db, clock, contextOf(room, 'alice'), { name: 'CI' });
      expect(await refusal(revokeWebhook(db, clock, bob, made.webhook.id))).toBe('FORBIDDEN');

      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('user_id', '=', bob.userId)
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect((await createWebhook(db, clock, bob, { name: 'Alerts' })).webhook.name).toBe('Alerts');

      const dm = await aRoom(db, ['carol', 'dave'], { type: 'direct_message' });
      expect(await refusal(createWebhook(db, clock, contextOf(dm, 'carol'), { name: 'CI' }))).toBe(
        'CHANNEL_NOT_FOUND',
      );
    });
  });

  test('the cap: the last one is made, one more is refused and writes nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      for (let n = 0; n < INCOMING_WEBHOOKS_PER_CHANNEL_MAX; n += 1) {
        await createWebhook(db, clock, alice, { name: `Hook ${String(n)}` });
      }
      expect(await refusal(createWebhook(db, clock, alice, { name: 'One more' }))).toBe(
        'INCOMING_WEBHOOKS_LIMIT',
      );
      expect(await channelWebhooks(db, alice)).toHaveLength(INCOMING_WEBHOOKS_PER_CHANNEL_MAX);
    });
  });

  test('revoked only in its own channel: another channel’s id, or no id at all, is not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const made = await createWebhook(db, clock, alice, { name: 'CI' });
      const elsewhere = await aRoom(db, ['carol']);
      const carol = contextOf(elsewhere, 'carol');
      expect(await refusal(revokeWebhook(db, clock, carol, made.webhook.id))).toBe(
        'INCOMING_WEBHOOK_NOT_FOUND',
      );
      expect(await refusal(revokeWebhook(db, clock, alice, 'not-a-uuid'))).toBe(
        'INCOMING_WEBHOOK_NOT_FOUND',
      );
      expect(await channelWebhooks(db, alice)).toHaveLength(1);

      await revokeWebhook(db, clock, alice, made.webhook.id);
      expect(await channelWebhooks(db, alice)).toEqual([]);
      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'metadata'])
        .where('workspace_id', '=', room.workspaceId)
        .where('action', '=', 'integration.webhook_revoked')
        .execute();
      expect(trail).toEqual([
        {
          action: 'integration.webhook_revoked',
          metadata: { name: 'CI', channelId: room.channelId },
        },
      ]);
      // Twice is not found the second time: there is nothing left to revoke.
      expect(await refusal(revokeWebhook(db, clock, alice, made.webhook.id))).toBe(
        'INCOMING_WEBHOOK_NOT_FOUND',
      );
    });
  });
});

describe('integration: a post through an incoming webhook', () => {
  test('posted: nobody’s, by the hook’s name, unread for everybody, telling nobody, announced', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { room } = world;
      // Bob follows everything in the channel, and is named: a hook still tells him nothing (D-245).
      await db
        .updateTable('channel_members')
        .set({ notification_level: 'all' })
        .where('channel_id', '=', room.channelId)
        .execute();

      const id = await world.post('**Deploy** finished — @bob, look');
      const message = await readBuilt(db, id);
      expect(message).toMatchObject({
        id,
        channelId: room.channelId,
        sender: null,
        githubEvent: null,
        incomingWebhook: { name: 'CI' },
        content: '**Deploy** finished — @bob, look',
        parentId: null,
        mentions: [],
      });
      for (const name of ['alice', 'bob']) {
        expect((await counters(db, room, idOf(room, name))).unread).toBe(1);
        expect((await counters(db, room, idOf(room, name))).mentions).toBe(0);
        expect(await notificationsOf(db, idOf(room, name))).toEqual([]);
      }
      expect(world.frames.map(([, frame]) => frame.event)).toEqual([
        'MESSAGE_CREATED',
        'CHANNEL_STATE',
        'CHANNEL_STATE',
      ]);
      const [topic, created] = world.frames[0] ?? [];
      expect(topic).toBe(channelTopic(room.channelId));
      expect(created?.event === 'MESSAGE_CREATED' && created.data.incomingWebhook).toEqual({
        name: 'CI',
      });

      const hook = await db
        .selectFrom('incoming_webhooks')
        .select('last_used_at')
        .where('id', '=', world.webhookId)
        .executeTakeFirstOrThrow();
      expect(hook.last_used_at).toEqual(NOW);
      const channel = await db
        .selectFrom('channels')
        .select('last_message_at')
        .where('id', '=', room.channelId)
        .executeTakeFirstOrThrow();
      expect(channel.last_message_at).toEqual(NOW);
      // One line for the post, and nothing of the secret or the words.
      expect(
        world.lines
          .filter((line) => line['msg'] === 'incoming webhook')
          .map((line) => [line['webhookId'], line['outcome']]),
      ).toEqual([[world.webhookId, 'posted']]);
      expect(JSON.stringify(world.lines)).not.toContain(world.secret);
      expect(JSON.stringify(world.lines)).not.toContain('Deploy');
    });
  });

  test('Turkish and emoji, and markup, are kept as they were written: the server renders nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const text =
        'Dağıtım başarısız: İstanbul şubesi 🚨\n<script>alert(1)</script><img src=x onerror=alert(2)>';
      const message = await readBuilt(db, await world.post(text));
      expect(message?.content).toBe(text);
    });
  });

  test('the same post twice is two messages: a hook is not idempotent', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const first = await world.post('Build 41 failed');
      const second = await world.post('Build 41 failed');
      expect(second).not.toBe(first);
      expect(await messagesIn(db, world.room.channelId)).toBe(2);
    });
  });

  test('a wrong secret, an id nobody made and no id at all are the one not found, and post nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const wrong = `${world.secret.slice(0, 63)}${world.secret.endsWith('0') ? '1' : '0'}`;
      expect(await world.post('x', { secret: wrong })).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(await world.post('x', { secret: '' })).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(await world.post('x', { webhookId: crypto.randomUUID() })).toBe(
        'INCOMING_WEBHOOK_NOT_FOUND',
      );
      expect(await world.post('x', { webhookId: 'not-a-uuid' })).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      // Another hook's secret does not open this one.
      const other = await createWebhook(db, clock, contextOf(world.room, 'alice'), {
        name: 'Other',
      });
      expect(await world.post('x', { secret: partsOf(other.path).secret })).toBe(
        'INCOMING_WEBHOOK_NOT_FOUND',
      );
      expect(await messagesIn(db, world.room.channelId)).toBe(0);
      // Nobody's bucket is spent by a stranger.
      expect(world.charged).toEqual([]);
      expect(JSON.stringify(world.lines)).not.toContain(wrong);
    });
  });

  test('a revoked hook posts nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await revokeWebhook(db, clock, contextOf(world.room, 'alice'), world.webhookId);
      expect(await world.post('x')).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(await messagesIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('a hook of an archived channel posts nothing, and posts again once it is restored', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await db
        .updateTable('channels')
        .set({ deleted_at: NOW })
        .where('id', '=', world.room.channelId)
        .execute();
      expect(await world.post('x')).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(await messagesIn(db, world.room.channelId)).toBe(0);
      // Refused before its bucket is charged: a hook that cannot post spends nothing.
      expect(world.charged).toEqual([]);
      await db
        .updateTable('channels')
        .set({ deleted_at: null })
        .where('id', '=', world.room.channelId)
        .execute();
      expect(await world.post('back')).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  test('a hook of a deleted workspace posts nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await db
        .updateTable('workspaces')
        .set({ deleted_at: NOW })
        .where('id', '=', world.room.workspaceId)
        .execute();
      expect(await world.post('x')).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(await messagesIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('past its bucket a hook is refused and posts nothing; the bucket is the hook’s own', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, true);
      expect(await world.post('x')).toBe('RATE_LIMITED');
      expect(world.charged).toEqual([world.webhookId]);
      expect(await messagesIn(db, world.room.channelId)).toBe(0);
    });
  });

  test('a post the name cannot be said for is refused loudly, never drawn', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      // A name the contract refuses, written past it: the reader would refuse it later, so the writer does now.
      await db
        .updateTable('incoming_webhooks')
        .set({ name: 'a‮b' })
        .where('id', '=', world.webhookId)
        .execute();
      expect(await world.post('x')).toContain('a name the contract cannot say');
    });
  });
});
