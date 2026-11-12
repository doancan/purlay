/** Company sockets do not inherit a canonical account's unrelated user-topic events. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { CLOSE_CODES, parseServerMessage, type ServerFrame } from '@purlay/types';
import { systemClock } from '../platform/clock';
import { NO_LOG, userTopic } from '../platform/events';
import { signInCompanyNative } from '../testing/company-native-auth';
import { aRoom } from '../testing/rooms';
import { inProcessEventBus } from './bus';
import { createSocketHub, OUTBOUND_HIGH_WATER_MARK } from './hub';
import { companyFrameProjector } from '../features/chat/channels/company-delivery';
import { startLivenessSweep } from './liveness';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';
import { channelFor } from '../features/chat/channels/channels';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const recordedSocket = async (): Promise<{
  readonly world: Awaited<ReturnType<typeof signInCompanyNative>>;
  readonly hub: ReturnType<typeof createSocketHub>;
  readonly sent: ServerFrame[];
  readonly closed: number[];
}> => {
  const world = await signInCompanyNative(clone.db);
  const sent: ServerFrame[] = [];
  const closed: number[] = [];
  const hub = createSocketHub(world.auth, systemClock, {
    log: NO_LOG,
    leave: () => undefined,
    listen: () => undefined,
    companyFrame: companyFrameProjector(clone.db),
  });
  expect(
    await hub.opened(
      'company',
      {
        send: (text): number => {
          const decoded = parseServerMessage(text);
          if (decoded.kind !== 'frame') throw new Error('Invalid server frame');
          sent.push(decoded.frame);
          return text.length;
        },
        buffered: () => 0,
        close: (code): void => {
          closed.push(code);
        },
      },
      new Request('https://purlay.test/ws', { headers: { cookie: world.cookie } }),
    ),
  ).toBeDefined();
  return { world, hub, sent, closed };
};

describe('integration: company socket authority', () => {
  test('the projection port preserves control replies and accepts only channel additions from its current company', async () => {
    const world = await signInCompanyNative(clone.db);
    const identity = {
      userId: world.companySession.userId,
      sessionId: world.companySession.sessionId,
      workspaceId: world.fixture.member.context.workspaceId,
    };
    const project = companyFrameProjector(clone.db);
    const signal = AbortSignal.timeout(3_000);
    const pong: ServerFrame = { event: 'PONG', data: {}, ts: 1 };
    expect(await project(identity, pong, signal)).toEqual(pong);
    const ended: ServerFrame = { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 2 };
    expect(await project(identity, ended, signal)).toEqual(ended);
    const ownRow = await clone.db
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', identity.workspaceId)
      .executeTakeFirstOrThrow();
    const own = await channelFor(clone.db, identity.userId, ownRow.id);
    const added: ServerFrame = { event: 'CHANNEL_ADDED', data: own, ts: 2 };
    expect(await project(identity, added, signal)).toEqual(added);
    const other = await aRoom(clone.db, ['projection-outsider']);
    const foreign = await channelFor(
      clone.db,
      other.members['projection-outsider']?.userId ?? '',
      other.channelId,
    );
    expect(
      await project(identity, { event: 'CHANNEL_ADDED', data: foreign, ts: 3 }, signal),
    ).toBeUndefined();
    expect(
      await project(
        identity,
        { event: 'ACCESS_REVOKED', data: { channelIds: [foreign.id] }, ts: 4 },
        signal,
      ),
    ).toBeUndefined();
  });

  test.each([
    'provider disabled',
    'domain revoked',
    'proof revoked',
    'old authentication revision',
    'account pending',
    'account suspended',
    'account deleted',
    'verification withdrawn',
    'workspace deleted',
    'membership restricted',
    'native session expired',
  ] as const)('cached identity cannot outlive %s', async (change) => {
    const { world, hub, sent } = await recordedSocket();
    try {
      expect(await hub.identity('company')).toBeDefined();
      const now = systemClock.now();
      const userId = world.companySession.userId;
      switch (change) {
        case 'provider disabled':
          await clone.db
            .updateTable('workspace_identity_connections')
            .set({ enabled: false })
            .where('id', '=', world.connection.id)
            .execute();
          break;
        case 'domain revoked':
          await clone.db
            .updateTable('workspace_identity_domains')
            .set({ revoked_at: now })
            .where('id', '=', world.connection.domainId)
            .execute();
          break;
        case 'proof revoked':
          await clone.db
            .updateTable('workspace_identity_sessions')
            .set({ revoked_at: now })
            .where('session_id', '=', world.companySession.sessionId)
            .execute();
          break;
        case 'old authentication revision':
          await clone.db
            .updateTable('workspace_identity_sessions')
            .set({ authentication_revision: crypto.randomUUID() })
            .where('session_id', '=', world.companySession.sessionId)
            .execute();
          break;
        case 'account pending':
          await clone.db
            .updateTable('users')
            .set({ admission_state: 'pending' })
            .where('id', '=', userId)
            .execute();
          break;
        case 'account suspended':
          await clone.db
            .updateTable('users')
            .set({ suspended_at: now })
            .where('id', '=', userId)
            .execute();
          break;
        case 'account deleted':
          await clone.db
            .updateTable('users')
            .set({ deleted_at: now })
            .where('id', '=', userId)
            .execute();
          break;
        case 'verification withdrawn':
          await clone.db
            .updateTable('users')
            .set({ admission_requires_verified_email: true, email_verified: false })
            .where('id', '=', userId)
            .execute();
          break;
        case 'workspace deleted':
          await clone.db
            .updateTable('workspaces')
            .set({ deleted_at: now })
            .where('id', '=', world.fixture.member.context.workspaceId)
            .execute();
          break;
        case 'membership restricted':
          await clone.db
            .updateTable('workspace_members')
            .set({
              access_kind: 'guest',
              guest_since: now,
              guest_modules: ['chat'],
              guest_expires_at: null,
            })
            .where('user_id', '=', userId)
            .where('workspace_id', '=', world.fixture.member.context.workspaceId)
            .execute();
          break;
        case 'native session expired':
          await clone.db
            .updateTable('sessions')
            .set({ expires_at: new Date(now.getTime() - 1) })
            .where('id', '=', world.companySession.sessionId)
            .execute();
          break;
      }
      expect(await hub.identity('company')).toBeUndefined();
      expect(sent.map((frame) => frame.event)).toEqual(['SESSION_ENDED']);
    } finally {
      hub.closed('company');
      await hub.settled();
    }
  });

  test('mixed channel revocations, state and presence are projected without losing valid issuing-workspace events', async () => {
    const { world, hub, sent, closed } = await recordedSocket();
    try {
      const other = await aRoom(clone.db, ['foreign-present-person']);
      const foreignUser = other.members['foreign-present-person']?.userId;
      if (foreignUser === undefined) throw new Error('Missing foreign person');
      await clone.db
        .insertInto('workspace_members')
        .values({
          workspace_id: other.workspaceId,
          user_id: world.companySession.userId,
          role: 'member',
        })
        .execute();
      const own = await clone.db
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', world.fixture.member.context.workspaceId)
        .executeTakeFirstOrThrow();
      hub.deliver('company', {
        event: 'CHANNEL_STATE',
        data: {
          channelId: other.channelId,
          state: { lastReadMessageId: null, unreadCount: 12, unreadMentionCount: 4 },
        },
        version: 1,
        ts: 1,
      });
      hub.deliver('company', {
        event: 'CHANNEL_STATE',
        data: {
          channelId: own.id,
          state: { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 1 },
        },
        version: 1,
        ts: 2,
      });
      hub.deliver('company', {
        event: 'ACCESS_REVOKED',
        data: { channelIds: [other.channelId, own.id] },
        ts: 3,
      });
      hub.deliver('company', {
        event: 'PRESENCE',
        data: {
          changes: [
            { userId: foreignUser, online: true, away: false, version: 1 },
            { userId: world.fixture.actor.context.userId, online: true, away: false, version: 2 },
          ],
        },
        ts: 4,
      });
      await hub.settled();
      expect(sent).toEqual([
        {
          event: 'CHANNEL_STATE',
          data: {
            channelId: own.id,
            state: { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 1 },
          },
          version: 1,
          ts: 2,
        },
        { event: 'ACCESS_REVOKED', data: { channelIds: [own.id] }, ts: 3 },
        {
          event: 'PRESENCE',
          data: {
            changes: [
              { userId: world.fixture.actor.context.userId, online: true, away: false, version: 2 },
            ],
          },
          ts: 4,
        },
      ]);
      expect(closed).toEqual([]);
    } finally {
      hub.closed('company');
      await hub.settled();
    }
  });

  test('a queued inbound frame and the liveness sweep reject a source retired after opening', async () => {
    const { world, hub, sent, closed } = await recordedSocket();
    const sweep = startLivenessSweep({
      database: clone.db,
      clock: systemClock,
      log: NO_LOG,
      source: { sessions: hub.sessions, end: hub.deliver, lifetime: () => NO_SESSION_LIFETIME },
    });
    try {
      const independentClosed: number[] = [];
      expect(
        await hub.opened(
          'independent',
          {
            send: (payload): number => payload.length,
            buffered: () => 0,
            close: (code): void => {
              independentClosed.push(code);
            },
          },
          new Request('https://purlay.test/ws', { headers: { cookie: world.memberCookie } }),
        ),
      ).toBeDefined();
      await clone.db
        .deleteFrom('workspace_identity_bindings')
        .where('connection_id', '=', world.connection.id)
        .execute();
      await sweep.tick();
      expect(sent.map((frame) => frame.event)).toEqual(['SESSION_ENDED']);
      expect(await hub.identity('company')).toBeUndefined();
      expect(sent.map((frame) => frame.event)).toEqual(['SESSION_ENDED']);
      expect(closed).toEqual([CLOSE_CODES.SESSION_ENDED]);
      expect((await hub.identity('independent'))?.userId).toBe(world.companySession.userId);
      expect(independentClosed).toEqual([]);
    } finally {
      sweep.stop();
      hub.closed('company');
      hub.closed('independent');
      await hub.settled();
    }
  });

  test('pending company projections share the transport byte bound and a session end preempts them', async () => {
    const { hub, sent, closed } = await recordedSocket();
    try {
      hub.deliver('company', {
        event: 'ERROR',
        data: { code: 'FORBIDDEN', message: 'x'.repeat(OUTBOUND_HIGH_WATER_MARK) },
        ts: 1,
      });
      expect(closed).toEqual([CLOSE_CODES.RESYNC]);
      expect(sent).toEqual([]);
      hub.deliver('company', { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 2 });
      expect(sent.map((frame) => frame.event)).toEqual(['SESSION_ENDED']);
    } finally {
      hub.closed('company');
      await hub.settled();
    }
  });

  test('unsolicited foreign workspace updates are omitted before they can close the issuing connection', async () => {
    const world = await signInCompanyNative(clone.db);
    const other = await aRoom(clone.db, ['other-socket-owner']);
    await clone.db
      .insertInto('workspace_members')
      .values({
        workspace_id: other.workspaceId,
        user_id: world.companySession.userId,
        role: 'member',
      })
      .execute();
    const sent: ServerFrame[] = [];
    const closed: number[] = [];
    const hub = createSocketHub(world.auth, systemClock, {
      companyFrame: companyFrameProjector(clone.db),
      log: NO_LOG,
      leave: () => undefined,
      listen: (identity) => {
        bus.subscribe(userTopic(identity.userId), identity.socketId);
      },
    });
    const bus = inProcessEventBus(hub.deliver, NO_LOG);
    try {
      expect(
        await hub.opened(
          'company',
          {
            send: (text): number => {
              const parsed = parseServerMessage(text);
              if (parsed.kind === 'frame') sent.push(parsed.frame);
              return text.length;
            },
            buffered: () => 0,
            close: (code): void => {
              closed.push(code);
            },
          },
          new Request('https://purlay.test/ws', { headers: { cookie: world.cookie } }),
        ),
      ).toBeDefined();
      await bus.publish(userTopic(world.companySession.userId), {
        event: 'WORKSPACE_UPDATED',
        data: { workspaceId: other.workspaceId, accessChanged: true },
        ts: 1,
      });
      await bus.publish(userTopic(world.companySession.userId), {
        event: 'NOTIFICATIONS_UPDATED',
        data: { workspaceId: world.fixture.member.context.workspaceId },
        ts: 2,
      });
      await hub.settled();
      expect(closed).toEqual([]);
      expect(sent).toEqual([
        {
          event: 'NOTIFICATIONS_UPDATED',
          data: { workspaceId: world.fixture.member.context.workspaceId },
          ts: 2,
        },
      ]);
      sent.length = 0;
      hub.hold('company');
      hub.deliver('company', {
        event: 'NOTIFICATIONS_UPDATED',
        data: { workspaceId: world.fixture.member.context.workspaceId },
        ts: 4,
      });
      hub.reply('company', [{ event: 'ACK', data: { channels: [] }, ts: 5 }]);
      await hub.settled();
      expect(sent.map((frame) => frame.event)).toEqual(['ACK', 'NOTIFICATIONS_UPDATED']);
      await clone.db
        .deleteFrom('workspace_identity_bindings')
        .where('connection_id', '=', world.connection.id)
        .execute();
      await bus.publish(userTopic(world.companySession.userId), {
        event: 'NOTIFICATIONS_UPDATED',
        data: { workspaceId: world.fixture.member.context.workspaceId },
        ts: 3,
      });
      await hub.settled();
      expect(sent.at(-1)?.event).toBe('SESSION_ENDED');
      expect(closed).toEqual([CLOSE_CODES.SESSION_ENDED]);
    } finally {
      hub.closed('company');
      await hub.settled();
    }
  });
});
