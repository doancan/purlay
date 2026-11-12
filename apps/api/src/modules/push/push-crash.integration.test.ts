/** A real committed notification survives SIGKILL, both before wake-up and before provider acknowledgement. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneIntegrationDatabase, closeIntegrationDatabase } from '@purlay/db';
import { nobodyActive } from '../../platform/attention';
import { NO_LOG } from '../../platform/events';
import { PUSH_LEASE_MS, PUSH_TTL_SECONDS } from '../../platform/push-policy';
import { NOW } from '../../testing/doubles';
import { enableTestPush, TEST_PUSH_POLICY } from '../../testing/push-config';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { movable, subscribe } from '../../testing/push-world';
import { aRoom } from '../../testing/rooms';
import { chatPushNotices } from '../../features/chat/notifications/push-notices';
import { noNoticeWords } from './notices';
import { createPushSender } from './sender';

afterAll(closeIntegrationDatabase);

describe('integration: actual push sender process death', () => {
  for (const stage of ['committed', 'provider'] as const) {
    test(`recovers after SIGKILL at ${stage}, without another notification or after-commit call`, async () => {
      const owned = await cloneIntegrationDatabase();
      const folder = mkdtempSync(join(tmpdir(), 'purlay-push-crash-'));
      const checkpoint = join(folder, 'ciphertext.json');
      try {
        const clock = movable(NOW);
        const room = await aRoom(owned.db, ['writer', 'reader'], { type: 'direct_message' });
        const recipient = room.members['reader']!.userId;
        const browser = await aBrowser();
        await enableTestPush(owned.db, clock);
        await subscribe(owned.db, clock, room.members['reader']!.userId, browser);
        const fixture = new URL('../../testing/push-crash-child.ts', import.meta.url).pathname;
        const child = Bun.spawn(['bun', '--no-env-file', fixture], {
          env: {
            ...process.env,
            DATABASE_URL: owned.connectionString,
            PUSH_CLOCK: NOW.toISOString(),
            PUSH_WRITER: room.members['writer']!.userId,
            PUSH_CHANNEL: room.channelId,
            PUSH_CHECKPOINT: checkpoint,
            PUSH_CRASH_STAGE: stage,
            PUSH_PUBLIC_KEY: KEYS.publicKey,
            PUSH_PRIVATE_KEY: KEYS.privateKey,
            PUSH_SUBJECT: KEYS.subject,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await child.exited;
        expect(child.signalCode).toBe('SIGKILL');
        const committed = await owned.db
          .selectFrom('push_deliveries')
          .selectAll()
          .where(
            'intent_id',
            'in',
            owned.db.selectFrom('push_intents').select('id').where('user_id', '=', recipient),
          )
          .executeTakeFirstOrThrow();
        expect(committed.attempts).toBe(stage === 'provider' ? 1 : 0);
        expect(committed.lease_id === null).toBe(stage === 'committed');
        expect(
          await owned.db
            .selectFrom('notifications')
            .select('read_at')
            .where('user_id', '=', recipient)
            .execute(),
        ).toEqual([{ read_at: null }]);
        const service = aPushService();
        const recovered = await createPushSender({
          database: owned.db,
          clock,
          log: NO_LOG,
          keys: KEYS,
          attention: nobodyActive,
          notices: chatPushNotices,
          noticeWords: noNoticeWords,
          ...TEST_PUSH_POLICY,
          post: service.post,
        });
        if (stage === 'provider') {
          clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS - 1));
          await recovered.releaseHeld();
          expect(service.sent).toEqual([]);
          clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS));
        }
        await recovered.flush(10_000);
        expect(service.sent).toHaveLength(1);
        const payload = await browser.read(service.sent[0]!.body);
        expect(JSON.stringify(payload)).not.toContain('Private crash fixture message');
        expect(JSON.stringify(payload)).toContain(`/c/${room.channelId}`);
        const final = await owned.db
          .selectFrom('push_deliveries')
          .selectAll()
          .where(
            'intent_id',
            'in',
            owned.db.selectFrom('push_intents').select('id').where('user_id', '=', recipient),
          )
          .executeTakeFirstOrThrow();
        expect(final.state).toBe('delivered');
        expect(final.attempts).toBe(stage === 'provider' ? 2 : 1);
        if (stage === 'provider') {
          const first = JSON.parse(readFileSync(checkpoint, 'utf8')) as {
            headers: Record<string, string>;
            body: string;
          };
          expect(service.sent[0]!.headers['topic']).toBe(first.headers['topic']);
          expect(Number(service.sent[0]!.headers['ttl'])).toBe(
            PUSH_TTL_SECONDS - PUSH_LEASE_MS / 1_000,
          );
          expect(await browser.read(Buffer.from(first.body, 'base64'))).toEqual(payload);
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
        await owned.drop();
      }
    }, 30_000);
  }
});
