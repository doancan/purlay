/** A real committed notification survives SIGKILL, both before wake-up and before provider acknowledgement. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type Database,
  type Selectable,
} from '@purlay/db';
import { nobodyActive } from '../../platform/attention';
import { NO_LOG } from '../../platform/events';
import { PUSH_LEASE_MS, PUSH_TTL_SECONDS } from '../../platform/push-policy';
import { NOW } from '../../testing/doubles';
import { enableTestPush, TEST_PUSH_POLICY } from '../../testing/push-config';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { movable, subscribe } from '../../testing/push-world';
import { aRoom, type Room } from '../../testing/rooms';
import { chatPushNotices } from '../../features/chat/notifications/push-notices';
import { noNoticeWords } from './notices';
import { createPushSender } from './sender';

afterAll(closeIntegrationDatabase);

const spawnSender = (
  databaseUrl: string,
  room: Room,
  clock: Date,
  stage: 'committed' | 'provider' | 'retry-initial' | 'retry-restart',
  fixtureEnvironment: Record<string, string>,
): Bun.Subprocess<'ignore', 'ignore', 'inherit'> =>
  Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      new URL('../../testing/push-crash-child.ts', import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PUSH_CLOCK: clock.toISOString(),
        PUSH_WRITER: room.members['writer']!.userId,
        PUSH_CHANNEL: room.channelId,
        PUSH_CRASH_STAGE: stage,
        PUSH_PUBLIC_KEY: KEYS.publicKey,
        PUSH_PRIVATE_KEY: KEYS.privateKey,
        PUSH_SUBJECT: KEYS.subject,
        ...fixtureEnvironment,
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );

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
        const child = spawnSender(owned.connectionString, room, NOW, stage, {
          PUSH_CHECKPOINT: checkpoint,
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

  test('a fresh sender process retries a persisted HTTP 503 on startup without a wake-up', async () => {
    const owned = await cloneIntegrationDatabase();
    try {
      const clock = movable(NOW);
      const room = await aRoom(owned.db, ['writer', 'reader'], { type: 'direct_message' });
      const recipient = room.members['reader']!.userId;
      const { slug } = await owned.db
        .selectFrom('workspaces')
        .select('slug')
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow();
      const browser = await aBrowser();
      await enableTestPush(owned.db, clock);
      await subscribe(owned.db, clock, recipient, browser);
      const delivery = owned.db
        .selectFrom('push_deliveries as delivery')
        .innerJoin('push_intents as intent', 'intent.id', 'delivery.intent_id')
        .selectAll('delivery')
        .where('intent.user_id', '=', recipient);
      const waitForStatus = async (
        status: number,
      ): Promise<Selectable<Database['push_deliveries']>> => {
        const deadline = Date.now() + 7_000;
        while (Date.now() < deadline) {
          const row = await delivery.executeTakeFirst();
          if (row?.last_status === status) return row;
          await Bun.sleep(20);
        }
        throw new Error(`No persisted push with status ${String(status)}`);
      };

      const attempts: { method: string; path: string; headers: Headers; body: Uint8Array }[] = [];
      let status = 503;
      const provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request): Promise<Response> => {
          attempts.push({
            method: request.method,
            path: new URL(request.url).pathname,
            headers: request.headers,
            body: new Uint8Array(await request.arrayBuffer()),
          });
          return new Response(null, {
            status,
            headers: status === 503 ? { 'retry-after': '12' } : {},
          });
        },
      });
      const env = { PUSH_LOOPBACK_PORT: String(provider.port) };
      let child: ReturnType<typeof spawnSender> | undefined;
      try {
        child = spawnSender(owned.connectionString, room, NOW, 'retry-initial', env);
        const pending = await waitForStatus(503);
        expect(pending).toMatchObject({
          state: 'pending',
          attempts: 1,
          lease_id: null,
          next_attempt_at: new Date(NOW.getTime() + 12_000),
        });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ method: 'POST', path: `/send/${recipient}` });
        child.kill('SIGKILL');
        await child.exited;
        expect(child.signalCode).toBe('SIGKILL');

        status = 201;
        child = spawnSender(
          owned.connectionString,
          room,
          pending.next_attempt_at,
          'retry-restart',
          env,
        );
        const delivered = await waitForStatus(201);
        expect(delivered).toMatchObject({
          intent_id: pending.intent_id,
          subscription_id: pending.subscription_id,
          session_id: pending.session_id,
          generation: pending.generation,
          state: 'delivered',
          attempts: 2,
          lease_id: null,
        });
        // Leave the new process alive through another poll to observe any duplicate POST.
        await Bun.sleep(1_100);
        expect(attempts).toHaveLength(2);
        expect(await delivery.execute()).toEqual([delivered]);
        const [first, second] = attempts;
        expect(second).toMatchObject({ method: 'POST', path: `/send/${recipient}` });
        expect(first!.headers.get('topic')).toMatch(/^[\w-]+$/);
        expect(second!.headers.get('topic')).toBe(first!.headers.get('topic'));
        expect(Number(first!.headers.get('ttl'))).toBe(PUSH_TTL_SECONDS);
        expect(Number(second!.headers.get('ttl'))).toBe(PUSH_TTL_SECONDS - 12);
        expect(second!.headers.get('content-encoding')).toBe('aes128gcm');
        const payload = await browser.read(second!.body);
        expect(await browser.read(first!.body)).toEqual(payload);
        expect(payload).toMatchObject({ url: `/w/${slug}/c/${room.channelId}` });
        expect(JSON.stringify(payload)).not.toContain('Private crash fixture message');
      } finally {
        child?.kill('SIGKILL');
        await child?.exited;
        await provider.stop(true);
      }
    } finally {
      await owned.drop();
    }
  }, 30_000);
});
