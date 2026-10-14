/**
 * A repository's feeds into a channel (#79, D-134): connected by an owner or an admin, its secret
 * sealed for its row and handed back once, never in the list, the row or the trail; a repository
 * once per channel, in either case, and no more than the cap; disconnected only in its own channel.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { GITHUB_FEEDS_PER_CHANNEL_MAX, type CreateGitHubFeedRequest } from '@purlay/types';
import type { ChannelContext } from '../../platform/channels';
import { fixedClock } from '../../platform/clock';
import { credentialCipher, SealBroken } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { aRoom, type Room } from '../../testing/rooms';
import { channelFeeds, createFeed, removeFeed } from './feeds';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
const cipher = credentialCipher(Buffer.alloc(32, 7).toString('base64'));
const PUSH: CreateGitHubFeedRequest = { repository: 'Acme/API', events: ['push'] };

const contextOf = (room: Room, name: string): ChannelContext => {
  const context = room.members[name]?.context;
  if (context === undefined) throw new Error(`no ${name}`);
  return context;
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('it was not refused');
};

const feedRows = async (db: Executor, channelId: string): Promise<number> =>
  (
    await db
      .selectFrom('github_repo_feeds')
      .select('id')
      .where('channel_id', '=', channelId)
      .execute()
  ).length;

describe('integration: a channel’s repository feeds', () => {
  test('connected: the feed, its address, and a secret sealed for its row and nowhere in the clear', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const made = await createFeed(db, clock, cipher, alice, PUSH);

      expect(made.feed).toEqual({
        id: made.feed.id,
        channelId: room.channelId,
        repository: 'acme/api',
        events: ['push'],
        createdAt: NOW.toISOString(),
        lastDeliveryAt: null,
        lastFailure: null,
      });
      expect(made.webhookPath).toBe(`/api/webhooks/github/${made.feed.id}`);
      expect(made.secret).toMatch(/^[0-9a-f]{64}$/);

      const row = await db
        .selectFrom('github_repo_feeds')
        .select(['secret_encrypted', 'created_by', 'workspace_id'])
        .where('id', '=', made.feed.id)
        .executeTakeFirstOrThrow();
      expect(row.secret_encrypted).not.toContain(made.secret);
      expect(await cipher.open(Buffer.from(row.secret_encrypted, 'base64'), made.feed.id)).toBe(
        made.secret,
      );
      expect([row.created_by, row.workspace_id]).toEqual([alice.userId, room.workspaceId]);

      expect(await channelFeeds(db, alice)).toEqual([made.feed]);
      expect(JSON.stringify(await channelFeeds(db, alice))).not.toContain(made.secret);

      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'target_id', 'metadata'])
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(trail).toEqual([
        {
          action: 'integration.feed_created',
          target_id: made.feed.id,
          metadata: { repository: 'acme/api' },
        },
      ]);
      expect(JSON.stringify(trail)).not.toContain(made.secret);
    });
  });

  test('each feed has its own secret, bound to its row: one feed’s does not open as another’s', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const first = await createFeed(db, clock, cipher, alice, PUSH);
      const second = await createFeed(db, clock, cipher, alice, {
        repository: 'acme/web',
        events: ['pull_request', 'issues'],
      });
      expect(second.secret).not.toBe(first.secret);
      const sealed = await db
        .selectFrom('github_repo_feeds')
        .select('secret_encrypted')
        .where('id', '=', first.feed.id)
        .executeTakeFirstOrThrow();
      const opened = await cipher
        .open(Buffer.from(sealed.secret_encrypted, 'base64'), second.feed.id)
        .then(
          () => 'opened',
          (error: unknown) => (error instanceof SealBroken ? 'broken' : 'another failure'),
        );
      expect(opened).toBe('broken');
    });
  });

  test('the same repository in another case is the same feed, refused; another channel may have it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      await createFeed(db, clock, cipher, alice, PUSH);
      expect(
        await refusal(
          createFeed(db, clock, cipher, alice, { repository: 'acme/api', events: ['release'] }),
        ),
      ).toBe('GITHUB_FEED_EXISTS');
      expect(await feedRows(db, room.channelId)).toBe(1);

      const elsewhere = await aRoom(db, ['carol']);
      const carol = contextOf(elsewhere, 'carol');
      expect((await createFeed(db, clock, cipher, carol, PUSH)).feed.repository).toBe('acme/api');
    });
  });

  test('a channel hears from as many repositories as the cap, and the next is refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      for (let n = 0; n < GITHUB_FEEDS_PER_CHANNEL_MAX; n++) {
        await createFeed(db, clock, cipher, alice, {
          repository: `acme/r${String(n)}`,
          events: ['push'],
        });
      }
      expect(await channelFeeds(db, alice)).toHaveLength(GITHUB_FEEDS_PER_CHANNEL_MAX);
      expect(
        await refusal(
          createFeed(db, clock, cipher, alice, { repository: 'acme/over', events: ['push'] }),
        ),
      ).toBe('GITHUB_FEEDS_LIMIT');
      expect(await feedRows(db, room.channelId)).toBe(GITHUB_FEEDS_PER_CHANNEL_MAX);
    });
  });

  test('a member is refused every one of the three, and nothing changes', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const made = await createFeed(db, clock, cipher, contextOf(room, 'alice'), PUSH);
      const bob = contextOf(room, 'bob');
      expect(await refusal(channelFeeds(db, bob))).toBe('FORBIDDEN');
      expect(
        await refusal(
          createFeed(db, clock, cipher, bob, { repository: 'acme/bob', events: ['push'] }),
        ),
      ).toBe('FORBIDDEN');
      expect(await refusal(removeFeed(db, clock, bob, made.feed.id))).toBe('FORBIDDEN');
      expect(await feedRows(db, room.channelId)).toBe(1);
    });
  });

  test('a direct message has no feeds: it is no channel to connect, list or disconnect', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const alice = contextOf(room, 'alice');
      expect(await refusal(channelFeeds(db, alice))).toBe('CHANNEL_NOT_FOUND');
      expect(await refusal(createFeed(db, clock, cipher, alice, PUSH))).toBe('CHANNEL_NOT_FOUND');
      expect(await refusal(removeFeed(db, clock, alice, crypto.randomUUID()))).toBe(
        'CHANNEL_NOT_FOUND',
      );
    });
  });

  test('an archived channel takes no new feed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      await db
        .updateTable('channels')
        .set({ deleted_at: NOW })
        .where('id', '=', room.channelId)
        .execute();
      expect(await refusal(createFeed(db, clock, cipher, contextOf(room, 'alice'), PUSH))).toBe(
        'CHANNEL_NOT_FOUND',
      );
    });
  });

  test('disconnected: gone, with its deliveries, and on the trail; only in its own channel', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      const made = await createFeed(db, clock, cipher, alice, PUSH);
      await db
        .insertInto('github_deliveries')
        .values({ feed_id: made.feed.id, delivery_id: 'a-delivery' })
        .execute();

      const other = await aRoom(db, ['carol']);
      expect(await refusal(removeFeed(db, clock, contextOf(other, 'carol'), made.feed.id))).toBe(
        'GITHUB_FEED_NOT_FOUND',
      );
      expect(await refusal(removeFeed(db, clock, alice, 'not-a-uuid'))).toBe(
        'GITHUB_FEED_NOT_FOUND',
      );
      expect(await refusal(removeFeed(db, clock, alice, crypto.randomUUID()))).toBe(
        'GITHUB_FEED_NOT_FOUND',
      );
      expect(await feedRows(db, room.channelId)).toBe(1);

      await removeFeed(db, clock, alice, made.feed.id);
      expect(await channelFeeds(db, alice)).toEqual([]);
      expect(await db.selectFrom('github_deliveries').select('feed_id').execute()).toEqual([]);
      const actions = await db
        .selectFrom('audit_log')
        .select('action')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      // One clock, so both rows have the same time: which came first is not what is asked.
      expect(actions.map((row) => row.action).sort()).toEqual([
        'integration.feed_created',
        'integration.feed_removed',
      ]);
      expect(await refusal(removeFeed(db, clock, alice, made.feed.id))).toBe(
        'GITHUB_FEED_NOT_FOUND',
      );
    });
  });

  test('the table refuses what the service never writes: an unknown event, no event, a bad name', async () => {
    for (const values of [
      { events: ['deployment'], repository_full_name: 'acme/api' },
      { events: [], repository_full_name: 'acme/api' },
      { events: ['push'], repository_full_name: 'Acme/API' },
    ]) {
      let outcome = 'not tried';
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice']);
        outcome = await db
          .insertInto('github_repo_feeds')
          .values({
            id: crypto.randomUUID(),
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            secret_encrypted: 'sealed',
            ...values,
          })
          .execute()
          .then(
            () => 'written',
            (error: unknown) => (error instanceof Error ? error.message : 'not an error'),
          );
      });
      expect({ values, refused: outcome.includes('check constraint') }).toEqual({
        values,
        refused: true,
      });
    }
  });
});
