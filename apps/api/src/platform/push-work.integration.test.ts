import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { NOW } from '../testing/doubles';
import { aWorkspaceRow } from '../testing/facts';
import { enableTestPush } from '../testing/push-config';
import { KEYS } from '../testing/push-service';
import { aSession, aSignedInUser } from '../testing/signed-in';
import { fixedClock } from './clock';
import { enqueuePush, type PushWork } from './push-work';

const clock = fixedClock(NOW);
const scope = 'a'.repeat(64);

afterAll(async () => {
  await closeIntegrationDatabase();
});

const notice = (userId: string, workspaceId: string, createdAt: Date = NOW): PushWork => ({
  source: 'inbox',
  sourceId: crypto.randomUUID(),
  recordId: crypto.randomUUID(),
  workspaceId,
  userId,
  module: 'issues',
  kind: 'assignment',
  createdAt,
});

const register = async (
  db: Executor,
  sessionId: string,
  token: string,
  providerScope = scope,
): Promise<string> => {
  const row = await db
    .insertInto('apns_subscriptions')
    .values({
      session_id: sessionId,
      device_token: token,
      provider_scope: providerScope,
      registered_at: NOW,
    })
    .returning('generation')
    .executeTakeFirstOrThrow();
  return row.generation;
};

describe('integration: capturing APNs push work', () => {
  test('without Web Push, only a live recipient device in the configured provider scope is captured', async () => {
    await withRollback(async (db) => {
      const recipient = await aSignedInUser(db, clock, 'apns-recipient');
      const outsider = await aSignedInUser(db, clock, 'apns-outsider');
      const otherScope = await aSession(db, clock, recipient.userId);
      const expired = await aSession(db, clock, recipient.userId);
      await db
        .updateTable('sessions')
        .set({ expires_at: new Date(NOW.getTime() - 1) })
        .where('id', '=', expired.sessionId)
        .execute();

      const generation = await register(db, recipient.sessionId, 'aa01');
      await register(db, otherScope.sessionId, 'aa02', 'b'.repeat(64));
      await register(db, expired.sessionId, 'aa03');
      await register(db, outsider.sessionId, 'aa04');

      const work = notice(recipient.userId, await aWorkspaceRow(db));
      await enqueuePush(db, NOW, [work]);
      expect(
        await db
          .selectFrom('push_intents')
          .select('id')
          .where('source_id', '=', work.sourceId)
          .execute(),
      ).toEqual([]);

      await enqueuePush(db, NOW, [work], undefined, scope);
      const intent = await db
        .selectFrom('push_intents')
        .selectAll()
        .where('source_id', '=', work.sourceId)
        .executeTakeFirstOrThrow();
      expect(intent).toMatchObject({ user_id: recipient.userId, source_id: work.sourceId });
      expect(
        await db
          .selectFrom('push_deliveries')
          .select(['intent_id', 'subscription_id', 'generation', 'session_id', 'apns_session_id'])
          .where('intent_id', '=', intent.id)
          .execute(),
      ).toEqual([
        {
          intent_id: intent.id,
          subscription_id: recipient.sessionId,
          generation,
          session_id: recipient.sessionId,
          apns_session_id: recipient.sessionId,
        },
      ]);
    });
  });

  test('Web Push and APNs share an intent and the same overflow bound', async () => {
    await withRollback(async (db) => {
      const recipient = await aSignedInUser(db, clock, 'apns-mixed');
      await enableTestPush(db, clock);
      await register(db, recipient.sessionId, 'bb01');
      const web = await db
        .insertInto('push_subscriptions')
        .values({
          user_id: recipient.userId,
          session_id: recipient.sessionId,
          endpoint: 'https://push.example.test/mixed',
          p256dh: 'fixture',
          auth: 'fixture',
          server_key: KEYS.publicKey,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const workspaceId = await aWorkspaceRow(db);
      const old = notice(recipient.userId, workspaceId, new Date(NOW.getTime() - 1));
      const latest = notice(recipient.userId, workspaceId);
      await enqueuePush(db, NOW, [old], 1, scope);
      await enqueuePush(db, NOW, [latest], 1, scope);
      const targets = await db
        .selectFrom('push_deliveries')
        .innerJoin('push_intents', 'push_intents.id', 'push_deliveries.intent_id')
        .select([
          'push_intents.source_id',
          'push_intents.state as intent_state',
          'push_deliveries.subscription_id',
          'push_deliveries.apns_session_id',
          'push_deliveries.state as delivery_state',
        ])
        .where('push_intents.source_id', 'in', [old.sourceId, latest.sourceId])
        .orderBy('push_intents.created_at')
        .orderBy('push_deliveries.apns_session_id', 'desc')
        .execute();
      expect(targets).toEqual(
        [
          { work: old, intent_state: 'overflow', delivery_state: 'canceled' },
          { work: latest, intent_state: 'pending', delivery_state: 'pending' },
        ].flatMap(({ work, ...state }) => [
          {
            source_id: work.sourceId,
            ...state,
            subscription_id: web.id,
            apns_session_id: null,
          },
          {
            source_id: work.sourceId,
            ...state,
            subscription_id: recipient.sessionId,
            apns_session_id: recipient.sessionId,
          },
        ]),
      );
    });
  });
});
