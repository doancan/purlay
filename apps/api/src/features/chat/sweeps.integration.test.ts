/** The sweeps of the rows chat keeps (D-23, D-134 §5, D-246): what is past its days goes, what is at them stays. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { aRoom } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { GITHUB_DELIVERIES_KEPT_DAYS, sweepGitHubDeliveries, sweepLinkPreviews } from './sweeps';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

describe('integration: the link-preview sweep (D-23)', () => {
  test('takes the previews past their expiry, at it included; the fresh stay', async () => {
    await withRollback(async (db) => {
      const preview = (
        hash: string,
        expires: Date,
      ): { url_hash: string; url: string; payload: string; expires_at: Date } => ({
        url_hash: hash,
        url: `https://github.com/acme/${hash}`,
        payload: JSON.stringify({ kind: 'missing' }),
        expires_at: expires,
      });
      await db
        .insertInto('link_previews')
        .values([
          preview('sweep-past', new Date(NOW.getTime() - 1)),
          preview('sweep-at', NOW),
          preview('sweep-fresh', new Date(NOW.getTime() + 1)),
        ])
        .execute();
      expect(await sweepLinkPreviews({ database: db, clock })).toEqual({ removed: 2 });
      const left = await db
        .selectFrom('link_previews')
        .select('url_hash')
        .where('url_hash', 'like', 'sweep-%')
        .execute();
      expect(left.map((row) => row.url_hash)).toEqual(['sweep-fresh']);
    });
  });
});

describe('integration: the delivery sweep (D-134 §5)', () => {
  test('forgets the ids older than the days they are kept; the one exactly that old stays', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const feed = crypto.randomUUID();
      await db
        .insertInto('github_repo_feeds')
        .values({
          id: feed,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          repository_full_name: 'acme/api',
          events: ['push'],
          secret_encrypted: 'sealed',
        })
        .execute();
      const kept = NOW.getTime() - GITHUB_DELIVERIES_KEPT_DAYS * 24 * 60 * 60 * 1000;
      await db
        .insertInto('github_deliveries')
        .values([
          { feed_id: feed, delivery_id: 'older', received_at: new Date(kept - 1) },
          { feed_id: feed, delivery_id: 'exactly', received_at: new Date(kept) },
          { feed_id: feed, delivery_id: 'newer', received_at: NOW },
        ])
        .execute();
      expect(await sweepGitHubDeliveries({ database: db, clock })).toEqual({ removed: 1 });
      const left = await db
        .selectFrom('github_deliveries')
        .select('delivery_id')
        .where('feed_id', '=', feed)
        .orderBy('delivery_id')
        .execute();
      expect(left.map((row) => row.delivery_id)).toEqual(['exactly', 'newer']);
    });
  });
});

describe('integration: the GitHub App’s sweep (D-246)', () => {
  test('forgets its deliveries past the days kept and the trips that expired, and nothing live', async () => {
    await withRollback(async (db) => {
      const days = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
      const digest = (n: number): string => n.toString(16).padStart(64, '0');
      await db
        .insertInto('github_app_deliveries')
        .values([
          { delivery_id: 'app-old', body_digest: digest(1), received_at: days(31) },
          { delivery_id: 'app-exactly', body_digest: digest(2), received_at: days(30) },
          { delivery_id: 'app-new', body_digest: digest(3), received_at: days(1) },
        ])
        .execute();
      const person = await aUserRow(db, 'sweeper');
      await db
        .insertInto('github_app_handshakes')
        .values(
          [-1, 0, 5].map((minutes, n) => ({
            state_digest: digest(100 + n),
            user_id: person.userId,
            workspace_id: null,
            purpose: 'authorize',
            verifier_encrypted: 'sealed',
            expires_at: new Date(NOW.getTime() + minutes * 60_000),
          })),
        )
        .execute();
      // The delivery past its days, and the two trips that were over at the instant of the sweep.
      expect(await sweepGitHubDeliveries({ database: db, clock })).toEqual({ removed: 3 });
      const deliveries = await db
        .selectFrom('github_app_deliveries')
        .select('delivery_id')
        .where('received_at', '>=', days(40))
        .orderBy('delivery_id')
        .execute();
      expect(deliveries.map((row) => row.delivery_id)).toEqual(['app-exactly', 'app-new']);
      const trips = await db
        .selectFrom('github_app_handshakes')
        .select('state_digest')
        .where('user_id', '=', person.userId)
        .execute();
      expect(trips).toEqual([{ state_digest: digest(102) }]);
    });
  });
});
