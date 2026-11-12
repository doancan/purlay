/** Company devices receive only their live issuing workspace, including durable recovery. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { systemClock } from '../../platform/clock';
import { atomicallyOn } from '../../platform/transactions';
import { nobodyActive } from '../../platform/attention';
import { NO_LOG } from '../../platform/events';
import { send } from '../../features/chat/messages/messages';
import { requireChannelById } from '../../features/chat/channels/guard';
import { chatPushNotices } from '../../features/chat/notifications/push-notices';
import { signInCompanyNative } from '../../testing/company-native-auth';
import { aRoom } from '../../testing/rooms';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { enableTestPush, TEST_PUSH_POLICY } from '../../testing/push-config';
import { PUSH_QUIET_BUS } from '../../testing/pending-push';
import {
  listCompanyConnections,
  setCompanyConnectionEnabled,
} from '../workspaces/identity/connections';
import { subscribe, unsubscribe, PUSH_SUBSCRIPTIONS_MAX } from './subscriptions';
import { AppError } from '../../platform/errors';
import { devicesFor } from './devices';
import { routeInbox } from './devices';
import { notificationSink } from '../inbox/sink';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { serverMetrics } from '../../platform/metrics';
import { words } from '../../testing/push-world';
import { currentPushDevice } from './authority';
import { claimPush, beginPushAttempt, ownsPushClaim } from './queue';
import { createPushSender, type PushSenderDependencies } from './sender';
import { noNoticeWords } from './notices';
import { withinRequest } from '../../platform/logging';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const setup = async (
  independent = true,
): Promise<{
  readonly world: Awaited<ReturnType<typeof signInCompanyNative>>;
  readonly other: Awaited<ReturnType<typeof aRoom>>;
  readonly say: (foreign: boolean) => Promise<string>;
  readonly companyEndpoint: string;
  readonly independentEndpoint: string;
  readonly dependencies: (post: PushSenderDependencies['post']) => PushSenderDependencies;
}> => {
  const world = await signInCompanyNative(clone.db);
  const member = world.fixture.member;
  const other = await aRoom(clone.db, ['other-company-writer'], { type: 'private' });
  await clone.db
    .insertInto('workspace_members')
    .values({
      workspace_id: other.workspaceId,
      user_id: member.context.userId,
      role: 'member',
    })
    .execute();
  await clone.db
    .insertInto('channel_members')
    .values({
      channel_id: other.channelId,
      user_id: member.context.userId,
    })
    .execute();
  await enableTestPush(clone.db, systemClock);
  const companyEndpoint = `https://push.example.com/company/${world.companySession.sessionId}`;
  const independentEndpoint = `https://push.example.com/independent/${member.sessionId}`;
  for (const [sessionId, endpoint] of [
    [world.companySession.sessionId, companyEndpoint],
    ...(independent ? [[member.sessionId, independentEndpoint]] : []),
  ]) {
    if (sessionId === undefined || endpoint === undefined) throw new Error('Missing push session');
    const browser = await aBrowser();
    await atomicallyOn(clone.db)(async (transaction) => {
      await subscribe(
        transaction,
        systemClock,
        { userId: member.context.userId, sessionId },
        { endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth }, locale: 'en' },
        KEYS.publicKey,
      );
    });
  }
  const username = (
    await clone.db
      .selectFrom('users')
      .select('username')
      .where('id', '=', member.context.userId)
      .executeTakeFirstOrThrow()
  ).username;
  const say = async (foreign: boolean): Promise<string> => {
    const actor = foreign
      ? other.members['other-company-writer']?.userId
      : world.fixture.actor.context.userId;
    if (actor === undefined) throw new Error('Missing writer');
    const channel = foreign
      ? other.channelId
      : (
          await clone.db
            .selectFrom('channels')
            .select('id')
            .where('workspace_id', '=', member.context.workspaceId)
            .executeTakeFirstOrThrow()
        ).id;
    const context = await requireChannelById(clone.db, actor, channel);
    return (
      await send(
        { atomically: atomicallyOn(clone.db), clock: systemClock, bus: PUSH_QUIET_BUS },
        context,
        { id: messageId(systemClock.now()), content: `@${username} company-specific message` },
      )
    ).id;
  };
  return {
    world,
    other,
    say,
    companyEndpoint,
    independentEndpoint,
    dependencies: (post): PushSenderDependencies => ({
      database: clone.db,
      clock: systemClock,
      keys: KEYS,
      log: NO_LOG,
      attention: nobodyActive,
      notices: chatPushNotices,
      noticeWords: noNoticeWords,
      ...TEST_PUSH_POLICY,
      post,
    }),
  };
};

describe('integration: company push authority', () => {
  test('a company request waking the global sender cannot cancel an independent device’s other-workspace message', async () => {
    const fixture = await setup();
    let available = false;
    const service = aPushService();
    const sender = await createPushSender({
      ...fixture.dependencies(service.post),
      available: () => available,
    });
    try {
      const message = await fixture.say(true);
      available = true;
      await withinRequest(
        {
          requestId: crypto.randomUUID(),
          startedAt: performance.now(),
          sessionId: fixture.world.companySession.sessionId,
          companySession: {
            userId: fixture.world.companySession.userId,
            workspaceId: fixture.world.fixture.member.context.workspaceId,
          },
        },
        async () => {
          sender.told(message, [fixture.world.companySession.userId]);
          await sender.flush(10_000);
        },
      );
      expect(service.sent.map((post) => post.url)).toEqual([fixture.independentEndpoint]);
    } finally {
      available = false;
      await sender.flush();
    }
  });

  test('company device changes cannot claim an independent endpoint without its browser keys', async () => {
    const fixture = await setup();
    const member = fixture.world.fixture.member;
    const browser = await aBrowser();
    const before = await clone.db
      .selectFrom('push_subscriptions')
      .selectAll()
      .where('endpoint', '=', fixture.independentEndpoint)
      .executeTakeFirstOrThrow();
    await atomicallyOn(clone.db)(async (transaction) => {
      await subscribe(
        transaction,
        systemClock,
        fixture.world.companySession,
        {
          endpoint: fixture.independentEndpoint,
          keys: { p256dh: browser.p256dh, auth: browser.auth },
          locale: 'en',
        },
        KEYS.publicKey,
      );
    });
    const unchanged = await clone.db
      .selectFrom('push_subscriptions')
      .selectAll()
      .where('endpoint', '=', fixture.independentEndpoint)
      .executeTakeFirstOrThrow();
    expect(unchanged).toEqual(before);
    // A browser proves the very subscription it already holds, so switching its session is valid.
    await atomicallyOn(clone.db)(async (transaction) => {
      await subscribe(
        transaction,
        systemClock,
        fixture.world.companySession,
        {
          endpoint: fixture.independentEndpoint,
          keys: { p256dh: before.p256dh, auth: before.auth },
          locale: 'en',
        },
        KEYS.publicKey,
      );
    });
    const moved = await clone.db
      .selectFrom('push_subscriptions')
      .select(['session_id', 'user_id'])
      .where('endpoint', '=', fixture.independentEndpoint)
      .executeTakeFirstOrThrow();
    expect(moved).toEqual({
      session_id: fixture.world.companySession.sessionId,
      user_id: member.context.userId,
    });
  });

  test('company unsubscribe leaves independent devices intact and removes only its issuing workspace device', async () => {
    const fixture = await setup();
    const owner = fixture.world.companySession;
    await unsubscribe(
      clone.db,
      owner.userId,
      fixture.independentEndpoint,
      owner.companyWorkspaceId,
    );
    expect(
      await clone.db
        .selectFrom('push_subscriptions')
        .select('id')
        .where('endpoint', '=', fixture.independentEndpoint)
        .executeTakeFirst(),
    ).toBeDefined();
    await unsubscribe(clone.db, owner.userId, fixture.companyEndpoint, owner.companyWorkspaceId);
    expect(
      await clone.db
        .selectFrom('push_subscriptions')
        .select('id')
        .where('endpoint', '=', fixture.companyEndpoint)
        .executeTakeFirst(),
    ).toBeUndefined();
    await unsubscribe(clone.db, owner.userId, fixture.independentEndpoint);
    expect(
      await clone.db
        .selectFrom('push_subscriptions')
        .select('id')
        .where('endpoint', '=', fixture.independentEndpoint)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  test('a full independent device inventory cannot be evicted by company enrollment; only proven company rows make room', async () => {
    const fixture = await setup(false);
    const owner = fixture.world.companySession;
    const browser = await aBrowser();
    await clone.db.deleteFrom('push_subscriptions').where('user_id', '=', owner.userId).execute();
    const endpoints = Array.from(
      { length: PUSH_SUBSCRIPTIONS_MAX },
      (_, index) => `https://push.example.com/cap/${owner.userId}/${String(index)}`,
    );
    for (const endpoint of endpoints)
      await atomicallyOn(clone.db)(async (transaction) => {
        await subscribe(
          transaction,
          systemClock,
          { userId: owner.userId, sessionId: fixture.world.fixture.member.sessionId },
          {
            endpoint,
            keys: { p256dh: browser.p256dh, auth: browser.auth },
            locale: 'en',
          },
          KEYS.publicKey,
        );
      });
    const endpoint = `https://push.example.com/cap/${owner.sessionId}/new`;
    const input = {
      endpoint,
      keys: { p256dh: browser.p256dh, auth: browser.auth },
      locale: 'en' as const,
    };
    let failure: unknown;
    try {
      await atomicallyOn(clone.db)(async (transaction) => {
        await subscribe(transaction, systemClock, owner, input, KEYS.publicKey);
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    if (failure instanceof AppError) expect(failure.body.code).toBe('FORBIDDEN');
    const kept = await clone.db
      .selectFrom('push_subscriptions')
      .select('endpoint')
      .where('user_id', '=', owner.userId)
      .execute();
    expect(new Set(kept.map((entry) => entry.endpoint))).toEqual(new Set(endpoints));
    const first = endpoints[0];
    if (first === undefined) throw new Error('Missing full device fixture');
    await atomicallyOn(clone.db)(async (transaction) => {
      await subscribe(
        transaction,
        systemClock,
        owner,
        { ...input, endpoint: first },
        KEYS.publicKey,
      );
    });
    await atomicallyOn(clone.db)(async (transaction) => {
      await subscribe(transaction, systemClock, owner, input, KEYS.publicKey);
    });
    const after = await clone.db
      .selectFrom('push_subscriptions')
      .select('endpoint')
      .where('user_id', '=', owner.userId)
      .execute();
    expect(new Set(after.map((entry) => entry.endpoint))).toEqual(
      new Set([...endpoints.slice(1), endpoint]),
    );
  });

  test('a live session cannot subscribe on behalf of another native person', async () => {
    const fixture = await setup();
    const browser = await aBrowser();
    const endpoint = `https://push.example.com/wrong-actor/${fixture.world.companySession.sessionId}`;
    let failure: unknown;
    try {
      await atomicallyOn(clone.db)(async (transaction) => {
        await subscribe(
          transaction,
          systemClock,
          {
            userId: fixture.world.fixture.actor.context.userId,
            sessionId: fixture.world.companySession.sessionId,
          },
          {
            endpoint,
            keys: { p256dh: browser.p256dh, auth: browser.auth },
            locale: 'en',
          },
          KEYS.publicKey,
        );
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    if (failure instanceof AppError) expect(failure.body.code).toBe('UNAUTHENTICATED');
    expect(
      await clone.db
        .selectFrom('push_subscriptions')
        .select('id')
        .where('endpoint', '=', endpoint)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  test('generic inbox pushes retain their native source workspace through capture and selection', async () => {
    const fixture = await setup();
    const metrics = serverMetrics(
      undefined,
      ['things'],
      [],
      [{ module: 'things', kind: 'thing_assigned' }],
    );
    const sink = notificationSink({
      module: 'things',
      clock: systemClock,
      kinds: new Map([['thing_assigned', 'things']]),
      bus: PUSH_QUIET_BUS,
      log: NO_LOG,
      written: metrics.inboxEntries,
      collapsed: metrics.inboxCollapsed,
      pushedKinds: new Set(['thing_assigned']),
    });
    const otherUser = fixture.other.members['other-company-writer']?.userId;
    if (otherUser === undefined) throw new Error('Missing other writer');
    const foreign = await requireWorkspaceMembership(
      clone.db,
      otherUser,
      fixture.other.workspaceId,
    );
    for (const context of [fixture.world.fixture.actor.context, foreign]) {
      const notice = await atomicallyOn(clone.db)(
        async (transaction) =>
          await sink.notify(transaction, context, {
            kind: 'thing_assigned',
            recipientId: fixture.world.companySession.userId,
            subject: { type: 'thing', id: crypto.randomUUID() },
            params: { title: 'Private company title' },
          }),
      );
      if (notice === undefined) throw new Error('Missing inbox notice');
      const routed = await routeInbox(
        { ...fixture.dependencies(aPushService().post), noticeWords: words },
        [notice.entryId],
      );
      const expected = [
        fixture.world.fixture.member.sessionId,
        ...(context.workspaceId === foreign.workspaceId
          ? []
          : [fixture.world.companySession.sessionId]),
      ];
      expect(new Set(routed.devices.map((device) => device.sessionId))).toEqual(new Set(expected));
      const captures = await clone.db
        .selectFrom('push_deliveries as d')
        .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
        .select('d.session_id')
        .where('p.record_id', '=', notice.entryId)
        .execute();
      expect(new Set(captures.map((row) => row.session_id))).toEqual(new Set(expected));
    }
  });

  test('capture, device selection and a restarted worker preserve the issuing workspace', async () => {
    const fixture = await setup();
    const foreign = await fixture.say(true);
    const captures = await clone.db
      .selectFrom('push_deliveries as d')
      .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
      .select('d.session_id')
      .where('p.record_id', '=', foreign)
      .execute();
    expect(captures.map((row) => row.session_id)).toEqual([fixture.world.fixture.member.sessionId]);
    const foreignDevices = await devicesFor(fixture.dependencies(aPushService().post), foreign, [
      fixture.world.fixture.member.context.userId,
    ]);
    expect(foreignDevices.map((device) => device.sessionId)).toEqual([
      fixture.world.fixture.member.sessionId,
    ]);
    const own = await fixture.say(false);
    const ownDevices = await devicesFor(fixture.dependencies(aPushService().post), own, [
      fixture.world.fixture.member.context.userId,
    ]);
    expect(new Set(ownDevices.map((device) => device.sessionId))).toEqual(
      new Set([fixture.world.companySession.sessionId, fixture.world.fixture.member.sessionId]),
    );
    const service = aPushService();
    const restarted = await createPushSender(fixture.dependencies(service.post));
    await restarted.flush(10_000);
    expect(service.sent.filter((post) => post.url === fixture.companyEndpoint)).toHaveLength(1);
    expect(service.sent.filter((post) => post.url === fixture.independentEndpoint)).toHaveLength(2);
  });

  test('a claimed device cannot be used for another workspace or survive provider revocation at the last handoff', async () => {
    const fixture = await setup(false);
    const foreign = await fixture.say(true);
    expect(
      await clone.db
        .selectFrom('push_intents')
        .select('id')
        .where('record_id', '=', foreign)
        .execute(),
    ).toEqual([]);
    await fixture.say(false);
    const dependencies = fixture.dependencies(aPushService().post);
    const claim = await claimPush(dependencies);
    if (claim === undefined) throw new Error('Missing captured company push');
    expect(await currentPushDevice(dependencies, claim)).toBeDefined();
    expect(
      await currentPushDevice(dependencies, { ...claim, workspaceId: fixture.other.workspaceId }),
    ).toBeUndefined();
    await clone.db
      .updateTable('sessions')
      .set({ company_workspace_id: fixture.other.workspaceId })
      .where('id', '=', fixture.world.companySession.sessionId)
      .execute();
    expect(await currentPushDevice(dependencies, claim)).toBeUndefined();
    await clone.db
      .updateTable('sessions')
      .set({ company_workspace_id: claim.workspaceId })
      .where('id', '=', fixture.world.companySession.sessionId)
      .execute();
    expect(await beginPushAttempt(clone.db, claim, systemClock.now(), KEYS.publicKey)).toBe(true);
    expect(await ownsPushClaim(clone.db, claim, systemClock.now(), KEYS.publicKey)).toBe(true);
    const connection = (
      await listCompanyConnections(fixture.world.fixture.dependencies, fixture.world.fixture.actor)
    ).data[0];
    if (connection === undefined) throw new Error('Missing provider');
    await setCompanyConnectionEnabled(
      fixture.world.fixture.dependencies,
      fixture.world.fixture.actor,
      connection.id,
      connection.revision,
      false,
    );
    expect(await currentPushDevice(dependencies, claim)).toBeUndefined();
    expect(await ownsPushClaim(clone.db, claim, systemClock.now(), KEYS.publicKey)).toBe(false);
    expect(await devicesFor(dependencies, claim.recordId, [claim.userId], claim.sourceId)).toEqual(
      [],
    );
    const retired = await fixture.say(false);
    expect(
      await clone.db
        .selectFrom('push_intents')
        .select('id')
        .where('record_id', '=', retired)
        .execute(),
    ).toEqual([]);
  });
});
