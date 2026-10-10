/**
 * The seed, run against a real database inside a transaction that is rolled back: what it
 * leaves is what the real send path produced, and nothing it does survives the test.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Channel, type Message } from '@purlay/types';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { createApp } from '../ingress/http/app';
import { fixedClock } from '../platform/clock';
import { testConfig, testDependencies } from '../testing/doubles';
import { neverSignsIn, plannedMessages, seedDemo } from './demo-seed';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');

describe('integration: the demo seed', () => {
  test('sends every message through the API, and leaves the counters the send path keeps', async () => {
    await withRollback(async (db) => {
      const config = testConfig();
      const manifest = await seedDemo({ database: db, config, now: NOW });
      expect(manifest.counts.messages).toBe(plannedMessages());

      // Read it back as the viewer, the way a browser does.
      const app = createApp(testDependencies({ database: db, clock: fixedClock(NOW), config }));
      const get = async (path: string): Promise<unknown> => {
        const response = await app.handle(
          new Request(`${config.APP_URL}${path}`, {
            headers: { cookie: manifest.personas.dogancan.cookie },
          }),
        );
        expect(response.status).toBe(200);
        return await response.json();
      };

      const channels = (await get(
        `/api/workspaces/${manifest.workspace.id}/channels`,
      )) as Channel[];
      for (const channel of channels) expect(Value.Check(Channel, channel)).toBe(true);
      const byName = Object.fromEntries(
        channels.map((c) => [c.name ?? c.peer?.username ?? '?', c]),
      );

      // The private channel is not the viewer's; the empty one is theirs and empty.
      expect(channels.some((c) => c.id === manifest.channels.security)).toBe(false);
      expect(byName['design']?.lastMessageAt).toBeNull();

      // Read mid-channel: part of #deploys and part of #api are unread, and the mentions waited.
      expect(byName['deploys']?.state?.unreadCount).toBe(80);
      expect(byName['api']?.state?.unreadCount).toBeGreaterThan(5);
      expect(byName['api']?.state?.unreadMentionCount).toBeGreaterThanOrEqual(3);
      expect(byName['incidents']?.state?.unreadMentionCount).toBeGreaterThanOrEqual(1);
      expect(byName['alice']?.type).toBe('direct_message');
      expect(byName['alice']?.state?.unreadCount).toBe(2);

      // Keyset pagination has something to page through.
      const page = (await get(`/api/channels/${manifest.channels.deploys}/messages?limit=100`)) as {
        data: unknown[];
        nextCursor: string | null;
      };
      expect(page.data).toHaveLength(100);
      expect(page.nextCursor).not.toBeNull();

      // Threads: one open with four replies, one resolved.
      const open = manifest.messages['backoff-question'];
      const resolved = manifest.messages['legacy-route'];
      const feed = (await get(`/api/channels/${manifest.channels.api}/messages?limit=100`)) as {
        data: Message[];
      };
      const rootOpen = feed.data.find((m) => m.id === open);
      const rootResolved = feed.data.find((m) => m.id === resolved);
      expect(rootOpen?.thread?.replyCount).toBe(4);
      expect(rootOpen?.thread?.resolvedAt).toBeNull();
      expect(rootResolved?.thread?.resolvedBy?.username).toBe('alice');
      expect(rootOpen?.reactions.length).toBeGreaterThan(0);
    });
  });

  test('refuses a database that already has the people, rather than duplicating them', async () => {
    await withRollback(async (db) => {
      const config = testConfig();
      await seedDemo({ database: db, config, now: NOW });
      let message = '';
      await seedDemo({ database: db, config, now: NOW }).catch((error: unknown) => {
        message = error instanceof Error ? error.message : '';
      });
      expect(message).toContain('already exist');
    });
  });

  test('never asks GitHub for anything: its sessions are its own', async () => {
    for (const call of [
      neverSignsIn.exchangeCode('code'),
      neverSignsIn.profile('token'),
      neverSignsIn.emails('token'),
    ]) {
      expect(
        await call.catch((error: unknown) => (error instanceof Error ? error.message : '')),
      ).toContain('never signs in');
    }
  });
});
