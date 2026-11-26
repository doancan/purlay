import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { exportPKCS8, generateKeyPair } from 'jose';
import { apnsScopeOf } from '../../platform/apns-credentials';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { nobodyActive } from '../../platform/attention';
import { NO_LOG } from '../../platform/events';
import { enqueuePush } from '../../platform/push-work';
import { testConfig } from '../../testing/doubles';
import { TEST_PUSH_POLICY } from '../../testing/push-config';
import { aBrowser, KEYS } from '../../testing/push-service';
import { aWorld, subscribe, words, type World } from '../../testing/push-world';
import { aSession, aSignedInUser, aTestAuth } from '../../testing/signed-in';
import { requireServerAdmin } from '../setup/setup';
import { noPushNotices } from './notices';
import { createApnsProvider } from './apns';
import { registerApnsDevice } from './apns-subscriptions';
import { beginPushAttempt, claimPush } from './queue';
import { settlePush } from './queue-result';
import { createPushSender, type PushSender } from './sender';
import { pushConfiguration } from './settings';

afterAll(closeIntegrationDatabase);

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const credentials = {
  environment: 'sandbox',
  teamId: 'TESTTEAM00',
  keyId: 'TESTKEY000',
  topic: 'com.purlay.ios',
  signingKey: await exportPKCS8(privateKey),
} as const;
const scope = apnsScopeOf(credentials);
const deviceToken = 'abab2323'.repeat(8);

const base = (database: Executor, world: World): Parameters<typeof createPushSender>[0] => ({
  database,
  clock: world.clock,
  keys: () => Promise.resolve(undefined),
  post: (): never => {
    throw new Error('Web Push must not post');
  },
  log: NO_LOG,
  attention: nobodyActive,
  notices: noPushNotices,
  noticeWords: words,
  ...TEST_PUSH_POLICY,
});

const queueInbox = async (db: Transaction, world: World, sender: PushSender): Promise<string> => {
  const notice = await world.write(world.ada);
  if (sender.capture === undefined) throw new Error('APNs capture is unavailable');
  await sender.capture(db, world.clock.now(), [
    {
      source: 'inbox',
      sourceId: notice.entryId,
      recordId: notice.entryId,
      workspaceId: world.workspaceId,
      userId: world.ada,
      module: notice.module,
      kind: notice.kind,
      createdAt: world.clock.now(),
    },
  ]);
  return notice.entryId;
};

describe('integration: the shared push queue delivers to APNs', () => {
  test('a native-only notice waits through Deep Work and quiet hours, then posts once', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { sessionId } = await aSession(db, world.clock, world.ada);
      const owner = { userId: world.ada, sessionId };
      await registerApnsDevice(db, world.clock, owner, deviceToken, scope);
      const deepWorkEnds = new Date(world.clock.now().getTime() + 120_000);
      await db
        .updateTable('workspace_members')
        .set({ is_deep_work_active: true, deep_work_until: deepWorkEnds })
        .where('workspace_id', '=', world.workspaceId)
        .where('user_id', '=', world.ada)
        .execute();
      const minute = world.clock.now().getUTCHours() * 60 + world.clock.now().getUTCMinutes();
      await db
        .updateTable('users')
        .set({
          time_zone: 'UTC',
          quiet_from: minute,
          quiet_to: minute + 5,
          quiet_days: 127,
          locale: 'tr',
        })
        .where('id', '=', world.ada)
        .execute();
      const posts: string[] = [];
      const send = await createApnsProvider(credentials, world.clock, (url, options) => {
        expect(url.pathname).toBe(`/3/device/${deviceToken}`);
        if (typeof options.body !== 'string') throw new Error('Missing APNs JSON body');
        posts.push(options.body);
        return Promise.resolve(new Response(null, { status: 200 }));
      });
      const dependencies = base(db, world);
      const sender = await createPushSender({ ...dependencies, apns: { scope, send } });
      const recordId = await queueInbox(db, world, sender);
      expect(await claimPush(dependencies)).toBeUndefined();
      expect(await claimPush({ ...dependencies, apnsScope: 'another-app' })).toBeUndefined();
      await sender.releaseHeld();
      expect(posts).toEqual([]);
      world.clock.to(new Date(deepWorkEnds.getTime() + 1_000));
      await sender.releaseHeld();
      expect(posts).toEqual([]);
      world.clock.to(new Date(deepWorkEnds.getTime() + 5 * 60_000));
      await sender.flush(10_000);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain('bob sana bir şey atadı');
      expect(posts[0]).not.toContain('secret plan');
      expect(
        await db
          .selectFrom('push_deliveries as d')
          .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
          .select(['d.state', 'd.attempts'])
          .where('p.record_id', '=', recordId)
          .executeTakeFirst(),
      ).toEqual({
        state: 'delivered',
        attempts: 1,
      });
    });
  });

  test('only a current registration and timestamp allow Apple to retire a token', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { sessionId } = await aSession(db, world.clock, world.ada);
      const owner = { userId: world.ada, sessionId };
      await registerApnsDevice(db, world.clock, owner, deviceToken, scope);
      let posts = 0;
      const send = await createApnsProvider(credentials, world.clock, async () => {
        posts++;
        if (posts === 1) await registerApnsDevice(db, world.clock, owner, deviceToken, scope);
        return Response.json(
          {
            reason: 'Unregistered',
            timestamp: world.clock.now().getTime() - (posts === 2 ? 10_000 : 0),
          },
          { status: 410 },
        );
      });
      const sender = await createPushSender({ ...base(db, world), apns: { scope, send } });
      await queueInbox(db, world, sender);
      await sender.releaseHeld();
      expect(posts).toBe(1);
      const registration = async (): Promise<string | undefined> =>
        (
          await db
            .selectFrom('apns_subscriptions')
            .select('device_token')
            .where('session_id', '=', sessionId)
            .executeTakeFirst()
        )?.device_token;
      expect(await registration()).toBe(deviceToken);

      await queueInbox(db, world, sender);
      await sender.releaseHeld();
      expect(posts).toBe(2);
      expect(await registration()).toBe(deviceToken);

      await queueInbox(db, world, sender);
      await sender.flush(10_000);
      expect(posts).toBe(3);
      expect(await registration()).toBeUndefined();
    });
  });

  test('a notice read after the alert was prepared never reaches Apple', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { sessionId } = await aSession(db, world.clock, world.ada);
      await registerApnsDevice(
        db,
        world.clock,
        { userId: world.ada, sessionId },
        deviceToken,
        scope,
      );
      let posted = false;
      const transport = await createApnsProvider(credentials, world.clock, () => {
        posted = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      });
      const send: typeof transport = async (push) => {
        await db
          .updateTable('inbox_entries')
          .set({ read_at: world.clock.now() })
          .where('id', '=', (eb) =>
            eb.selectFrom('push_intents').select('record_id').where('id', '=', push.collapseId),
          )
          .execute();
        return await transport(push);
      };
      const sender = await createPushSender({ ...base(db, world), apns: { scope, send } });
      const recordId = await queueInbox(db, world, sender);
      await sender.flush(10_000);
      expect(posted).toBe(false);
      expect(
        await db
          .selectFrom('push_deliveries as d')
          .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
          .select(['d.attempts', 'd.state'])
          .where('p.record_id', '=', recordId)
          .executeTakeFirst(),
      ).toEqual({ attempts: 0, state: 'canceled' });
    });
  });

  test('a temporary Apple refusal is recovered by a fresh worker with the same collapse ID', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { sessionId } = await aSession(db, world.clock, world.ada);
      await registerApnsDevice(
        db,
        world.clock,
        { userId: world.ada, sessionId },
        deviceToken,
        scope,
      );
      const collapseIds: (string | null)[] = [];
      const send = await createApnsProvider(credentials, world.clock, (_url, options) => {
        collapseIds.push(new Headers(options.headers).get('apns-collapse-id'));
        return Promise.resolve(
          collapseIds.length === 1
            ? new Response(null, { status: 503, headers: { 'retry-after': '10' } })
            : new Response(null, { status: 200 }),
        );
      });
      const dependencies = { ...base(db, world), apns: { scope, send } };
      const sender = await createPushSender(dependencies);
      const recordId = await queueInbox(db, world, sender);
      await sender.flush(10_000);
      const queued = await db
        .selectFrom('push_deliveries as d')
        .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
        .select(['d.attempts', 'd.state', 'd.next_attempt_at'])
        .where('p.record_id', '=', recordId)
        .executeTakeFirstOrThrow();
      expect(queued).toEqual({
        attempts: 1,
        state: 'pending',
        next_attempt_at: new Date(world.clock.now().getTime() + 10_000),
      });
      world.clock.to(queued.next_attempt_at);
      const restarted = await createPushSender(dependencies);
      await restarted.flush(10_000);
      expect(collapseIds).toHaveLength(2);
      expect(collapseIds[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(collapseIds[1]).toBe(collapseIds[0]);
    });
  });

  test('disabling and re-enabling Web Push leaves the APNs side of the same intent deliverable', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, (transaction, now, work): Promise<void> =>
        enqueuePush(transaction, now, work, undefined, scope),
      );
      const { sessionId } = await aSession(db, world.clock, world.ada);
      await registerApnsDevice(
        db,
        world.clock,
        { userId: world.ada, sessionId },
        deviceToken,
        scope,
      );
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const notice = await world.write(world.ada);
      const dependencies = { ...base(db, world), keys: KEYS };
      const webClaim = await claimPush(dependencies);
      if (webClaim === undefined) throw new Error('Missing Web Push lease');
      expect(await beginPushAttempt(db, webClaim, world.clock.now(), KEYS.publicKey)).toBe(true);
      const admin = await aSignedInUser(db, world.clock, 'push-admin');
      await db
        .updateTable('users')
        .set({ is_server_admin: true })
        .where('id', '=', admin.userId)
        .execute();
      const actor = await requireServerAdmin(
        aTestAuth(db, { clock: world.clock }),
        db,
        new Headers({ cookie: admin.cookie }),
      );
      const settings = pushConfiguration(
        db,
        credentialCipher(DEVELOPMENT_ENCRYPTION_KEY),
        world.clock,
        testConfig(),
      );
      await settings.change(actor, false);
      await settings.change(actor, true);
      await settlePush(db, webClaim, { kind: 'delivered', status: 201 }, world.clock);
      expect(
        (
          await db
            .selectFrom('push_deliveries')
            .select('state')
            .where('intent_id', '=', webClaim.intentId)
            .where('subscription_id', '=', webClaim.subscriptionId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('pending');
      expect(await claimPush(dependencies)).toBeUndefined();
      let posts = 0;
      const send = await createApnsProvider(credentials, world.clock, () => {
        posts++;
        return Promise.resolve(new Response(null, { status: 200 }));
      });
      const sender = await createPushSender({ ...dependencies, apns: { scope, send } });
      await sender.flush(10_000);
      expect(posts).toBe(1);
      expect(
        await db
          .selectFrom('push_intents')
          .select(['state', 'web_canceled'])
          .where('record_id', '=', notice.entryId)
          .executeTakeFirst(),
      ).toEqual({ state: 'completed', web_canceled: true });
    });
  });
});
