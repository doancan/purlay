/** Real native sources remain separate across live output, background jobs and prepared archives. @needs-modules chat */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, sql, type Transaction } from '@purlay/db';
import { messageId, parseServerMessage, type ServerFrame } from '@purlay/types';
import { aRoom } from '../testing/rooms';
import { aSession, aTestAuth } from '../testing/signed-in';
import { aMovableClock } from '../testing/doubles';
import { NO_LOG } from '../platform/events';
import { SESSION_COOKIE } from '../platform/cookies';
import { withinRequest } from '../platform/logging';
import { atomicallyOn } from '../platform/transactions';
import { requireWorkspaceSecurityMembership } from '../platform/tenancy';
import { withinDeferredSource } from '../platform/deferred-source';
import { credentialCipher } from '../platform/crypto';
import { recordPrimaryAuthentication } from '../modules/auth/authentication-evidence';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';
import { createSocketHub } from '../realtime/hub';
import { workspaceFrameProjector } from '../features/chat/channels/workspace-delivery';
import { liveChannelScope } from '../features/chat/channels/live-history';
import { requireChannelById } from '../features/chat/channels/guard';
import { sendMessage } from '../features/chat/messages/messages';
import { scheduleMessage } from '../features/chat/scheduled/scheduled';
import { deliverScheduled } from '../features/chat/scheduled/delivery';
import { setReminder } from '../features/chat/reminders/reminders';
import { deliverReminders } from '../features/chat/reminders/delivery';
import { PUSH_QUIET_BUS } from '../testing/pending-push';
import { eligiblePushSources } from '../modules/push/workspace-access';
import { workspaceAccessStatus } from '../modules/workspaces/security/access';
import {
  claimPersonalDownload,
  requestPersonalExport,
  runPersonalExport,
} from '../modules/export/personal-requests';
import { exportCatalogue, personalExportCatalogue } from '../export-catalogue';
import { exportPerson } from '../modules/export/personal';
import { aMemoryStore } from '../testing/storage';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routeFrame } from '../realtime/router';
import { nobodyActive } from '../platform/attention';
import { inMemoryPresenceRegistry } from '../realtime/presence';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from '../realtime/rate-limiter';
import { aBrowser, KEYS } from '../testing/push-service';
import { enableTestPush, TEST_PUSH_POLICY } from '../testing/push-config';
import { subscribe } from '../modules/push/subscriptions';
import { devicesFor } from '../modules/push/devices';
import { claimPush } from '../modules/push/queue';
import { createDelivery } from '../modules/push/delivery';
import { chatPushNotices } from '../features/chat/notifications/push-notices';
import { noNoticeWords } from '../modules/push/notices';
import { send } from '../features/chat/messages/messages';
import { fixedClock } from '../platform/clock';
import { legacyPersonalWorkspaces, requirePreparedWorkspaceSet } from '../modules/export/source';
import { companyWorkspaceMfaActor } from '../modules/workspaces/security/mfa.testing';
import {
  readWorkspaceContentPermits,
  requireWorkspaceSessionAccess,
} from '../platform/workspace-content-fence';
import { lockWorkspaceProjectionScope } from '../modules/workspaces/provisioning/scope';
import { requireManualWorkspaceSource } from '../modules/workspaces/provisioning/native-state';
import { blockWorkspaceAdmission } from '../modules/workspaces/provisioning/source-offboarding';
import { activeWorkspaceMembership } from '../platform/tenancy';
import { createSocketLifecycle } from '../ingress/ws/socket';
import { chatFrameHandlers } from '../features/chat/frames';
import { testConfig } from '../testing/doubles';
import { channelTopic } from '../platform/events';

afterAll(closeIntegrationDatabase);
const fixture = async (
  db: Transaction,
): Promise<{
  readonly db: Transaction;
  readonly a: Awaited<ReturnType<typeof aRoom>>;
  readonly b: Awaited<ReturnType<typeof aRoom>>;
  readonly clock: ReturnType<typeof aMovableClock>;
  readonly userId: string;
  readonly source: Awaited<ReturnType<typeof aSession>>;
  readonly dependencies: {
    readonly database: Transaction;
    readonly clock: ReturnType<typeof aMovableClock>;
    readonly sessionLifetime: () => typeof NO_SESSION_LIFETIME;
  };
  readonly inSource: <T>(work: () => Promise<T>) => Promise<T>;
}> => {
  const a = await aRoom(db, ['source', 'writer']);
  const b = await aRoom(db, ['other']);
  const person = a.members['source'];
  if (person === undefined) throw new Error('Missing source');
  const userId = person.userId;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: b.workspaceId, user_id: userId, role: 'member' })
    .execute();
  await db
    .insertInto('channel_members')
    .values({ channel_id: b.channelId, user_id: userId })
    .execute();
  const clock = aMovableClock(new Date());
  const source = await aSession(db, clock, userId);
  await recordPrimaryAuthentication(db, source.sessionId, userId, {
    method: 'password',
    authenticatedAt: clock.now(),
  });
  const dependencies = {
    database: db,
    clock,
    sessionLifetime: (): typeof NO_SESSION_LIFETIME => NO_SESSION_LIFETIME,
  };
  for (const workspaceId of [a.workspaceId, b.workspaceId]) {
    await db
      .updateTable('workspaces')
      .set({ access_policy_epoch: '1' })
      .where('id', '=', workspaceId)
      .execute();
    await db
      .insertInto('workspace_access_policies')
      .values({
        workspace_id: workspaceId,
        epoch: '1',
        mode: 'enforced',
        sign_in: 'any',
        require_mfa: false,
        idle_minutes: 15,
        max_age_hours: 1,
        mfa_max_age_minutes: 5,
      })
      .execute();
    expect(
      (
        await workspaceAccessStatus(
          {
            ...dependencies,
            lifetime: dependencies.sessionLifetime,
            cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
          },
          {
            context: await requireWorkspaceSecurityMembership(db, userId, workspaceId),
            sessionId: source.sessionId,
          },
        )
      ).state,
    ).toBe('allowed');
  }
  return {
    db,
    a,
    b,
    clock,
    userId,
    source,
    dependencies,
    inSource: async <T>(work: () => Promise<T>): Promise<T> =>
      await withinDeferredSource(dependencies, { userId, sessionId: source.sessionId }, work),
  };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

const capturedCompanyRows = async (
  f: Fixture,
  sessionId: string,
): Promise<() => Promise<number>> => {
  const permit = (
    await readWorkspaceContentPermits(f.db, {
      workspaceId: f.a.workspaceId,
      sessionIds: [sessionId],
      now: f.clock.now(),
      lifetime: f.dependencies.sessionLifetime(),
    })
  ).get(sessionId);
  if (permit === undefined) throw new Error('Missing actual company content permit');
  expect(permit.decision.allowed).toBe(true);
  return async (): Promise<number> =>
    await withinRequest(
      { requestId: 'captured-company-origin', startedAt: 0, sessionId },
      async () => {
        permit.capture(f.clock.now());
        return (
          await f.db
            .selectFrom('workspaces')
            .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
            .select('workspaces.id')
            .where('workspaces.id', '=', f.a.workspaceId)
            .where('workspace_members.user_id', '=', f.userId)
            .where(activeWorkspaceMembership())
            .execute()
        ).length;
      },
    );
};
const endA = async (f: Fixture): Promise<void> => {
  await f.db
    .updateTable('workspace_session_assurances')
    .set({ ended_at: f.clock.now(), end_reason: 'source_revoked' })
    .where('workspace_id', '=', f.a.workspaceId)
    .where('session_id', '=', f.source.sessionId)
    .execute();
};
const revised = (
  channelId: string,
  content: string,
  message: string = crypto.randomUUID(),
): ServerFrame => ({
  event: 'MESSAGE_REVISED',
  ts: 1,
  version: 1,
  data: {
    channelId,
    messageId: message,
    parentId: null,
    content,
    editedAt: null,
    deletedAt: null,
    mentions: [],
  },
});
const activity = async (
  f: Fixture,
): Promise<readonly { readonly workspace_id: string; readonly last_used_at: Date }[]> =>
  await f.db
    .selectFrom('workspace_session_assurances')
    .select(['workspace_id', 'last_used_at'])
    .where('session_id', '=', f.source.sessionId)
    .orderBy('workspace_id')
    .execute();

describe('integration: workspace delivery provenance', () => {
  test('a missed guest extension hint retires only a workspace whose actual policy now requires remediation', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await db
        .updateTable('workspace_members')
        .set({
          role: 'member',
          access_kind: 'guest',
          guest_since: new Date(f.clock.now().getTime() - 1_000),
          guest_expires_at: new Date(f.clock.now().getTime() + 1_000),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', f.a.workspaceId)
        .where('user_id', '=', f.userId)
        .execute();
      const frames: ServerFrame[] = [];
      const closes: number[] = [];
      const hub = createSocketHub(aTestAuth(db), f.clock, {
        log: NO_LOG,
        leave: () => undefined,
        listen: () => undefined,
        workspaceFrame: workspaceFrameProjector(db, f.clock, f.dependencies.sessionLifetime),
      });
      try {
        await hub.opened(
          'missed-policy',
          {
            send: (text): number => {
              frames.push(JSON.parse(text) as ServerFrame);
              return text.length;
            },
            buffered: () => 0,
            close: (code): void => {
              closes.push(code);
            },
          },
          new Request('https://purlay.test/ws', {
            headers: { cookie: `${SESSION_COOKIE}=${f.source.token}` },
          }),
        );
        for (const channelId of [f.a.channelId, f.b.channelId])
          hub.restrictChannel?.(
            'missed-policy',
            channelId,
            await f.inSource(async () =>
              liveChannelScope()(db, await requireChannelById(db, f.userId, channelId)),
            ),
          );
        await db
          .updateTable('workspace_members')
          .set({ guest_expires_at: new Date(f.clock.now().getTime() + 3_600_000) })
          .where('workspace_id', '=', f.a.workspaceId)
          .where('user_id', '=', f.userId)
          .execute();
        await endA(f);
        f.clock.advance(1_001);
        hub.deliver('missed-policy', revised(f.a.channelId, 'obsolete guest output'));
        await hub.settled();
        expect(frames).toMatchObject([
          {
            event: 'ERROR',
            workspaceId: f.a.workspaceId,
            data: { code: 'WORKSPACE_ACCESS_REQUIRED' },
          },
        ]);
        const b: ServerFrame = { event: 'PINS_UPDATED', data: { channelId: f.b.channelId }, ts: 1 };
        hub.deliver('missed-policy', b);
        await hub.settled();
        expect(frames.at(-1)).toEqual(b);
        expect(closes).toEqual([]);
      } finally {
        hub.closed('missed-policy');
        await hub.settled();
      }
    });
  });

  test.each([
    'before-source',
    'source-query',
    'clock-expired',
    'clock-failure',
    'final-query',
    'abort-final',
  ] as const)(
    'the final native projector fails closed at the actual %s boundary',
    async (stage) => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const signal = new AbortController();
        const failure = new Error(`actual delivery boundary: ${stage}`);
        const selected = new Set<unknown>();
        let finalQueries = 0;
        const watched = db.withPlugin({
          transformQuery: (args) => {
            const node = JSON.stringify(args.node);
            const final = node.includes('"alias":{"kind":"IdentifierNode","name":"ready_sources"}');
            if (final) finalQueries++;
            if (
              (stage === 'final-query' && final) ||
              (stage === 'source-query' &&
                node.includes('"name":"workspaces"') &&
                node.includes('"name":"access_policy_epoch"'))
            )
              selected.add(args.queryId);
            return args.node;
          },
          transformResult: (args) => {
            if (selected.delete(args.queryId)) throw failure;
            return Promise.resolve(args.result);
          },
        });
        let clockReads = 0;
        const deliveryClock = {
          now: (): Date => {
            clockReads++;
            if (clockReads === 2) {
              if (stage === 'clock-expired') f.clock.advance(900_001);
              if (stage === 'clock-failure') throw failure;
              if (stage === 'abort-final') signal.abort(failure);
            }
            return f.clock.now();
          },
        };
        const before = await activity(f);
        const frame: ServerFrame = {
          event: 'INBOX_UPDATED',
          data: { workspaceId: f.a.workspaceId },
          ts: 1,
        };
        const pending = workspaceFrameProjector(
          watched,
          deliveryClock,
          f.dependencies.sessionLifetime,
        )({ userId: f.userId, sessionId: f.source.sessionId }, [], frame, signal.signal);
        if (stage === 'before-source') signal.abort(failure);
        const result: unknown = await pending.catch((error: unknown) => error);
        if (stage === 'clock-expired')
          expect(result).toEqual({ workspaceId: f.a.workspaceId, channelIds: [] });
        else expect(result).toBe(failure);
        expect(finalQueries).toBe(stage === 'final-query' || stage === 'abort-final' ? 1 : 0);
        expect(await activity(f)).toEqual(before);
      });
    },
  );

  test('the actual socket lifecycle binds inbound and outbound enforcement to the admitted native SID', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const frames: ServerFrame[] = [];
      const closes: number[] = [];
      const lifecycle = createSocketLifecycle({
        database: db,
        auth: aTestAuth(db),
        clock: f.clock,
        log: NO_LOG,
        config: testConfig(),
        attention: nobodyActive,
        userWrites: inProcessRateLimiter(f.clock, SOCKET_FRAME_BUDGET),
        frameHandlers: chatFrameHandlers,
        closedFrame: () => false,
        moduleOfFrame: () => 'chat',
        deadlineOf: () => 3_000,
        closedEvent: (event) => event === 'PRESENCE',
      });
      const socket = {
        id: 'policy-lifecycle',
        raw: {
          getBufferedAmount: (): number => 0,
          send: (text: string): number => {
            frames.push(JSON.parse(text) as ServerFrame);
            return text.length;
          },
        },
        data: {
          request: new Request('https://purlay.test/ws', {
            headers: { cookie: `${SESSION_COOKIE}=${f.source.token}` },
          }),
        },
        close: (code: number): void => {
          closes.push(code);
        },
      };
      try {
        await lifecycle.open(socket);
        lifecycle.message(socket, {
          id: crypto.randomUUID(),
          op: 'SUBSCRIBE',
          payload: { channels: [{ channelId: f.a.channelId, afterMessageId: null }] },
        });
        await lifecycle.settled();
        expect(frames.some((frame) => frame.event === 'ACK')).toBe(true);
        frames.length = 0;
        const allowed = revised(f.a.channelId, 'allowed lifecycle content');
        await lifecycle.bus.publish(channelTopic(f.a.channelId), allowed);
        await lifecycle.settled();
        expect(frames).toEqual([allowed]);
        await endA(f);
        frames.length = 0;
        lifecycle.message(socket, {
          id: crypto.randomUUID(),
          op: 'ACTIVE',
          payload: { workspaceId: f.a.workspaceId },
        });
        await lifecycle.settled();
        expect(frames).toMatchObject([
          {
            event: 'ERROR',
            workspaceId: f.a.workspaceId,
            data: { code: 'WORKSPACE_ACCESS_REQUIRED' },
          },
        ]);
        expect(closes).toEqual([]);
      } finally {
        lifecycle.closeAll();
        lifecycle.close(socket, 1000);
        await lifecycle.settled();
      }
    });
  });

  test('a reminder whose original native session ended is removed without borrowing a live unrelated session', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      let id = '';
      await f.inSource(async () => {
        const context = await requireChannelById(db, f.userId, f.a.channelId);
        id = (
          await sendMessage(db, f.clock, context, {
            id: messageId(f.clock.now()),
            content: 'original reminder',
          })
        ).message.id;
        await setReminder(
          db,
          f.clock,
          f.userId,
          id,
          new Date(f.clock.now().getTime() + 60_000).toISOString(),
        );
      });
      await aSession(db, f.clock, f.userId);
      await db.deleteFrom('sessions').where('id', '=', f.source.sessionId).execute();
      f.clock.advance(60_001);
      expect(await deliverReminders({ ...f.dependencies, bus: PUSH_QUIET_BUS, log: NO_LOG })).toBe(
        0,
      );
      expect(
        await db
          .selectFrom('message_reminders')
          .select('id')
          .where('message_id', '=', id)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('message_id', '=', id)
          .where('type', '=', 'reminder')
          .execute(),
      ).toEqual([]);
    });
  });

  test('a batch native SID cannot stand for another canonical user in the same workspace', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const other = f.a.members['writer'];
      if (other === undefined) throw new Error('Missing second canonical user');
      const frame = revised(f.a.channelId, 'wrong native owner must not read');
      const result = await workspaceFrameProjector(db, f.clock, f.dependencies.sessionLifetime)(
        { sessionId: f.source.sessionId, userId: other.userId },
        [f.a.channelId],
        frame,
        AbortSignal.timeout(3_000),
      );
      expect(result).toEqual({ workspaceId: f.a.workspaceId, channelIds: [] });
    });
  });
  test('the final SQL history cutoff blocks a queued edit after a same-millisecond guest floor change', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const base = new Date(f.clock.now().getTime() - 1_000);
      const stamp = (micros: string): string => base.toISOString().replace('Z', `${micros}Z`);
      const context = await f.inSource(
        async () => await requireChannelById(db, f.userId, f.a.channelId),
      );
      const message = await f.inSource(
        async () =>
          await sendMessage(db, fixedClock(base), context, {
            id: messageId(base),
            content: 'same millisecond guest boundary',
          }),
      );
      await sql`update messages set created_at=${stamp('150')}::timestamptz where id=${message.message.id}`.execute(
        db,
      );
      await sql`update workspace_members set role='member',access_kind='guest',guest_since=${stamp('100')}::timestamptz,guest_modules=ARRAY['chat']::text[] where workspace_id=${f.a.workspaceId} and user_id=${f.userId}`.execute(
        db,
      );
      const guest = await f.inSource(
        async () => await requireChannelById(db, f.userId, f.a.channelId),
      );
      const sent: ServerFrame[] = [];
      const hub = createSocketHub(aTestAuth(db, { clock: f.clock }), f.clock, {
        log: NO_LOG,
        listen: () => undefined,
        leave: () => undefined,
        workspaceFrame: workspaceFrameProjector(db, f.clock, f.dependencies.sessionLifetime),
      });
      expect(
        await hub.opened(
          'micro',
          {
            buffered: () => 0,
            close: () => undefined,
            send: (text) => {
              const parsed = parseServerMessage(text);
              if (parsed.kind !== 'frame') throw new Error('Invalid history frame');
              sent.push(parsed.frame);
              return text.length;
            },
          },
          new Request('https://purlay.test/ws', {
            headers: { cookie: `${SESSION_COOKIE}=${f.source.token}` },
          }),
        ),
      ).toBeDefined();
      try {
        const scope = liveChannelScope()(db, guest);
        hub.restrictChannel?.('micro', f.a.channelId, {
          ...scope,
          accepts: async (frame, signal) => {
            const accepted = await scope.accepts(frame, signal);
            expect(accepted).toBe(true);
            await sql`update workspace_members set guest_since=${stamp('200')}::timestamptz where workspace_id=${f.a.workspaceId} and user_id=${f.userId}`.execute(
              db,
            );
            return accepted;
          },
        });
        hub.deliver(
          'micro',
          revised(f.a.channelId, 'must stay behind the SQL cutoff', message.message.id),
        );
        await hub.settled();
        expect(sent).toEqual([]);
      } finally {
        hub.closed('micro');
        await hub.settled();
      }
    });
  });
  test('a captured non-directory company source cannot adopt a different native directory origin', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const dependencies = {
        ...f.dependencies,
        lifetime: f.dependencies.sessionLifetime,
        cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
      };
      const company = await companyWorkspaceMfaActor(dependencies, {
        context: await requireWorkspaceSecurityMembership(db, f.userId, f.a.workspaceId),
        sessionId: f.source.sessionId,
      });
      expect((await workspaceAccessStatus(dependencies, company.actor)).state).toBe('allowed');
      const rows = await capturedCompanyRows(f, company.actor.sessionId);
      expect(await rows()).toBe(1);
      await db
        .updateTable('sessions')
        .set({ directory_id: crypto.randomUUID() })
        .where('id', '=', company.actor.sessionId)
        .execute();
      expect(await rows()).toBe(0);
      expect(
        (
          await readWorkspaceContentPermits(db, {
            workspaceId: f.a.workspaceId,
            sessionIds: [company.actor.sessionId],
            now: f.clock.now(),
            lifetime: f.dependencies.sessionLifetime(),
          })
        ).get(company.actor.sessionId)?.decision.allowed,
      ).toBe(false);
    });
  });

  test.each(['active', 'inactive', 'retired', 'blocked'] as const)(
    'captured company manual admission remains exact when its retained state is %s',
    async (state) => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const dependencies = {
          ...f.dependencies,
          lifetime: f.dependencies.sessionLifetime,
          cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
        };
        const company = await companyWorkspaceMfaActor(dependencies, {
          context: await requireWorkspaceSecurityMembership(db, f.userId, f.a.workspaceId),
          sessionId: f.source.sessionId,
        });
        const scope = await lockWorkspaceProjectionScope(db, f.a.workspaceId);
        const source = await requireManualWorkspaceSource(db, f.clock, scope, f.userId);
        expect((await workspaceAccessStatus(dependencies, company.actor)).state).toBe('allowed');
        const rows = await capturedCompanyRows(f, company.actor.sessionId);
        expect(await rows()).toBe(1);
        if (state === 'blocked') await blockWorkspaceAdmission(db, f.clock, scope, f.userId);
        else if (state !== 'active')
          await db
            .updateTable('workspace_access_sources')
            .set({
              state,
              retired_at: state === 'retired' ? f.clock.now() : null,
              revision: crypto.randomUUID(),
              authorization_revision: crypto.randomUUID(),
              updated_at: f.clock.now(),
            })
            .where('workspace_id', '=', f.a.workspaceId)
            .where('id', '=', source.id)
            .execute();
        expect(await rows()).toBe(state === 'active' ? 1 : 0);
        expect(
          (
            await readWorkspaceContentPermits(db, {
              workspaceId: f.a.workspaceId,
              sessionIds: [company.actor.sessionId],
              now: f.clock.now(),
              lifetime: f.dependencies.sessionLifetime(),
            })
          ).get(company.actor.sessionId)?.decision.allowed,
        ).toBe(state === 'active');
        expect(
          await db
            .selectFrom('workspace_members')
            .select('user_id')
            .where('workspace_id', '=', f.a.workspaceId)
            .where('user_id', '=', f.userId)
            .execute(),
        ).toHaveLength(1);
      });
    },
  );

  test.each(['guest', 'deleted', 'suspended'] as const)(
    'captured corporate final proof rejects current outer-row %s retirement',
    async (change) => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const dependencies = {
          ...f.dependencies,
          lifetime: f.dependencies.sessionLifetime,
          cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
        };
        const company = await companyWorkspaceMfaActor(dependencies, {
          context: await requireWorkspaceSecurityMembership(db, f.userId, f.a.workspaceId),
          sessionId: f.source.sessionId,
        });
        expect((await workspaceAccessStatus(dependencies, company.actor)).state).toBe('allowed');
        await withinRequest(
          {
            requestId: 'captured-corporate-final',
            startedAt: 0,
            sessionId: company.actor.sessionId,
          },
          async () => {
            await requireWorkspaceSessionAccess(db, {
              sessionId: company.actor.sessionId,
              userId: f.userId,
              workspaceId: f.a.workspaceId,
              now: f.clock.now(),
              lifetime: f.dependencies.sessionLifetime(),
            });
            const rows = async (): Promise<number> =>
              (
                await db
                  .selectFrom('workspaces')
                  .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
                  .select('workspaces.id')
                  .where('workspaces.id', '=', f.a.workspaceId)
                  .where('workspace_members.user_id', '=', f.userId)
                  .where(activeWorkspaceMembership())
                  .execute()
              ).length;
            expect(await rows()).toBe(1);
            if (change === 'guest')
              await db
                .updateTable('workspace_members')
                .set({
                  role: 'member',
                  access_kind: 'guest',
                  guest_since: f.clock.now(),
                  guest_modules: ['chat'],
                })
                .where('workspace_id', '=', f.a.workspaceId)
                .where('user_id', '=', f.userId)
                .execute();
            else
              await db
                .updateTable('users')
                .set(
                  change === 'deleted'
                    ? { deleted_at: f.clock.now() }
                    : { suspended_at: f.clock.now() },
                )
                .where('id', '=', f.userId)
                .execute();
            expect(await rows()).toBe(0);
          },
        );
      });
    },
  );
  test('a full member converted after the actual audience read cannot receive queued pre-guest history', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const context = await f.inSource(
        async () => await requireChannelById(db, f.userId, f.a.channelId),
      );
      const old = await f.inSource(
        async () =>
          await sendMessage(db, fixedClock(new Date(f.clock.now().getTime() - 60_000)), context, {
            id: messageId(new Date(f.clock.now().getTime() - 60_000)),
            content: 'old full-member words',
          }),
      );
      const sent: ServerFrame[] = [];
      const hub = createSocketHub(aTestAuth(db, { clock: f.clock }), f.clock, {
        log: NO_LOG,
        listen: () => undefined,
        leave: () => undefined,
        workspaceFrame: workspaceFrameProjector(db, f.clock, f.dependencies.sessionLifetime),
      });
      await hub.opened(
        'conversion',
        {
          buffered: () => 0,
          close: () => undefined,
          send: (text) => {
            const result = parseServerMessage(text);
            if (result.kind !== 'frame') throw new Error('Invalid conversion frame');
            sent.push(result.frame);
            return text.length;
          },
        },
        new Request('https://purlay.test/ws', {
          headers: { cookie: `${SESSION_COOKIE}=${f.source.token}` },
        }),
      );
      try {
        const scope = liveChannelScope()(db, context);
        hub.restrictChannel?.('conversion', f.a.channelId, {
          ...scope,
          accepts: async (frame, signal) => {
            const accepted = await scope.accepts(frame, signal);
            expect(accepted).toBe(true);
            await db
              .updateTable('workspace_members')
              .set({
                access_kind: 'guest',
                role: 'member',
                guest_since: new Date(f.clock.now().getTime() - 1_000),
                guest_modules: ['chat'],
              })
              .where('workspace_id', '=', f.a.workspaceId)
              .where('user_id', '=', f.userId)
              .execute();
            return accepted;
          },
        });
        hub.deliver(
          'conversion',
          revised(f.a.channelId, 'pre-guest revised words', old.message.id),
        );
        await hub.settled();
        expect(sent.some((frame) => frame.event === 'MESSAGE_REVISED')).toBe(false);
        expect(sent).toContainEqual({
          event: 'WORKSPACE_UPDATED',
          ts: f.clock.now().getTime(),
          data: { workspaceId: f.a.workspaceId, accessChanged: true },
        });
      } finally {
        hub.closed('conversion');
        await hub.settled();
      }
    });
  });
  test('governed recipient metadata stays live; held/replay A is retired while B and the native socket continue without activity', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const sent: ServerFrame[] = [];
      const closed: number[] = [];
      const left: string[] = [];
      const hub = createSocketHub(aTestAuth(db, { clock: f.clock }), f.clock, {
        log: NO_LOG,
        listen: () => undefined,
        leave: (id) => {
          left.push(id);
        },
        workspaceFrame: workspaceFrameProjector(db, f.clock, f.dependencies.sessionLifetime),
      });
      expect(
        await hub.opened(
          's',
          {
            buffered: () => 0,
            close: (code) => {
              closed.push(code);
            },
            send: (text) => {
              const parsed = parseServerMessage(text);
              if (parsed.kind !== 'frame') throw new Error('Invalid frame');
              sent.push(parsed.frame);
              return text.length;
            },
          },
          new Request('https://purlay.test/ws', {
            headers: { cookie: `${SESSION_COOKIE}=${f.source.token}` },
          }),
        ),
      ).toBeDefined();
      try {
        const scopes = liveChannelScope();
        await f.inSource(async () => {
          for (const id of [f.a.channelId, f.b.channelId])
            hub.restrictChannel?.('s', id, scopes(db, await requireChannelById(db, f.userId, id)));
        });
        const before = await activity(f);
        hub.deliver('s', revised(f.a.channelId, 'allowed A'));
        await hub.settled();
        expect(
          sent.some(
            (frame) => frame.event === 'MESSAGE_REVISED' && frame.data.content === 'allowed A',
          ),
        ).toBe(true);
        sent.length = 0;
        hub.hold('s');
        hub.deliver('s', revised(f.a.channelId, 'held A'));
        await endA(f);
        hub.reply('s', [revised(f.a.channelId, 'replay A'), revised(f.b.channelId, 'allowed B')]);
        await hub.settled();
        expect(
          sent
            .filter((frame) => frame.event === 'MESSAGE_REVISED')
            .map((frame) => frame.data.content),
        ).toEqual(['allowed B']);
        expect(sent.find((frame) => frame.event === 'ERROR')).toMatchObject({
          event: 'ERROR',
          workspaceId: f.a.workspaceId,
          data: { code: 'WORKSPACE_ACCESS_REQUIRED' },
        });
        expect(left).toEqual([f.a.channelId]);
        expect(closed).toEqual([]);
        expect(await hub.identity('s')).toMatchObject({ sessionId: f.source.sessionId });
        expect(await activity(f)).toEqual(before);
        hub.deliver('s', {
          event: 'WORKSPACE_UPDATED',
          ts: 1,
          data: { workspaceId: f.a.workspaceId, accessChanged: true },
        });
        hub.deliver('s', revised(f.b.channelId, 'B after A access hint'));
        await hub.settled();
        expect(sent.at(-1)).toMatchObject({
          event: 'MESSAGE_REVISED',
          data: { content: 'B after A access hint' },
        });
        expect(closed).toEqual([]);
      } finally {
        hub.closed('s');
        await hub.settled();
      }
    });
  });

  test('ACTIVE refreshes only allowed A; denied A cannot refresh B or its own terminal proof', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const before = await activity(f);
      f.clock.advance(61_000);
      const active = async (workspaceId: string): Promise<readonly ServerFrame[]> =>
        await f.inSource(
          async () =>
            await routeFrame(
              {
                ...f.dependencies,
                atomically: atomicallyOn(db),
                bus: PUSH_QUIET_BUS,
                log: NO_LOG,
                limiter: inProcessRateLimiter(f.clock, SOCKET_FRAME_BUDGET),
                userWrites: inProcessRateLimiter(f.clock, SOCKET_FRAME_BUDGET),
                presence: inMemoryPresenceRegistry(f.clock),
                attention: nobodyActive,
                online: { active: () => undefined },
                socket: { hold: () => undefined, isOpen: () => true, drop: () => undefined },
              },
              {
                socketId: 's',
                userId: f.userId,
                sessionId: f.source.sessionId,
                expiresAt: new Date(f.clock.now().getTime() + 86_400_000),
              },
              { id: crypto.randomUUID(), op: 'ACTIVE', payload: { workspaceId } },
            ),
        );
      expect(await active(f.a.workspaceId)).toEqual([]);
      const after = await activity(f);
      expect(after.find((row) => row.workspace_id === f.a.workspaceId)?.last_used_at).toEqual(
        f.clock.now(),
      );
      expect(after.find((row) => row.workspace_id === f.b.workspaceId)).toEqual(
        before.find((row) => row.workspace_id === f.b.workspaceId),
      );
      await endA(f);
      f.clock.advance(61_000);
      expect(await active(f.a.workspaceId)).toMatchObject([
        {
          event: 'ERROR',
          workspaceId: f.a.workspaceId,
          data: { code: 'WORKSPACE_ACCESS_REQUIRED' },
        },
      ]);
      expect(await activity(f)).toEqual(after);
    });
  });

  test('push cohorts use the exact native source, deny unknown/missing lifetimes and never adopt or touch A/B proof', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const legacy = await aSession(db, f.clock, f.userId);
      const epochs = new Map([
        [f.a.workspaceId, '1'],
        [f.b.workspaceId, '1'],
      ]);
      const candidates = [f.source.sessionId, legacy.sessionId, crypto.randomUUID()].flatMap(
        (sessionId) =>
          [f.a.workspaceId, f.b.workspaceId].map((workspaceId) => ({ workspaceId, sessionId })),
      );
      const before = await activity(f);
      expect([...(await eligiblePushSources(f.dependencies, epochs, candidates))].sort()).toEqual(
        [
          `${f.a.workspaceId}:${f.source.sessionId}`,
          `${f.b.workspaceId}:${f.source.sessionId}`,
        ].sort(),
      );
      expect(
        (await eligiblePushSources({ database: db, clock: f.clock }, epochs, candidates)).size,
      ).toBe(0);
      await endA(f);
      expect([...(await eligiblePushSources(f.dependencies, epochs, candidates))]).toEqual([
        `${f.b.workspaceId}:${f.source.sessionId}`,
      ]);
      expect(await activity(f)).toEqual(before);
      expect(
        await db
          .selectFrom('workspace_session_assurances')
          .select('session_id')
          .where('session_id', '=', legacy.sessionId)
          .execute(),
      ).toEqual([]);
    });
  });

  test.each([false, true])(
    'a prepared encrypted push uses the actual recipient source, including final handoff revoked=%s',
    async (revoked) => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const writer = f.a.members['writer'];
        const reader = f.a.members['source'];
        if (writer === undefined || reader === undefined) throw new Error('Missing push people');
        const writerSession = await aSession(db, f.clock, writer.userId);
        await recordPrimaryAuthentication(db, writerSession.sessionId, writer.userId, {
          method: 'password',
          authenticatedAt: f.clock.now(),
        });
        await workspaceAccessStatus(
          {
            ...f.dependencies,
            lifetime: f.dependencies.sessionLifetime,
            cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
          },
          {
            context: await requireWorkspaceSecurityMembership(db, writer.userId, f.a.workspaceId),
            sessionId: writerSession.sessionId,
          },
        );
        await enableTestPush(db, f.clock);
        const browser = await aBrowser();
        await subscribe(
          db,
          f.clock,
          { userId: f.userId, sessionId: f.source.sessionId },
          {
            endpoint: `https://push.example.com/${f.source.sessionId}`,
            keys: { p256dh: browser.p256dh, auth: browser.auth },
            locale: 'en',
          },
          KEYS.publicKey,
        );
        const message = await withinDeferredSource(
          f.dependencies,
          { userId: writer.userId, sessionId: writerSession.sessionId },
          async () =>
            await send(
              {
                atomically: atomicallyOn(db),
                clock: f.clock,
                bus: PUSH_QUIET_BUS,
              },
              await requireChannelById(db, writer.userId, f.a.channelId),
              {
                id: messageId(f.clock.now()),
                content: `@${reader.username} actual queued message`,
              },
            ),
        );
        const dependencies = {
          ...f.dependencies,
          log: NO_LOG,
          keys: KEYS,
          attention: nobodyActive,
          notices: chatPushNotices,
          noticeWords: noNoticeWords,
          ...TEST_PUSH_POLICY,
        };
        const devices = await devicesFor(dependencies, message.id, [f.userId]);
        expect(devices).toHaveLength(1);
        const claim = await claimPush(dependencies);
        const device = devices[0];
        if (claim === undefined || device === undefined)
          throw new Error('Missing actual durable push');
        expect(claim.sessionId).toBe(f.source.sessionId);
        let keysRead = 0;
        let posts = 0;
        const before = await activity(f);
        const deliver = await createDelivery(
          {
            ...dependencies,
            keys: async () => {
              keysRead += 1;
              if (keysRead === 2 && revoked) await endA(f);
              return KEYS;
            },
            post: async (_url, _headers, body) => {
              posts += 1;
              expect(await browser.read(body)).toMatchObject(device.payload);
              return { kind: 'answered' as const, status: 201 };
            },
          },
          { failed: () => undefined },
        );
        expect(await deliver(device, claim)).toEqual(
          revoked ? { kind: 'canceled' } : { kind: 'delivered', status: 201 },
        );
        expect(keysRead).toBe(2);
        expect(posts).toBe(revoked ? 0 : 1);
        expect(await activity(f)).toEqual(before);
        expect(
          await db
            .selectFrom('push_deliveries')
            .select('attempts')
            .where('intent_id', '=', claim.intentId)
            .executeTakeFirst(),
        ).toEqual({ attempts: 1 });
      });
    },
  );

  test('scheduled/reminder sources are captured at the producer and background cannot borrow an unrelated session', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const sendAt = new Date(f.clock.now().getTime() + 60_000).toISOString();
      const scheduled = messageId(f.clock.now());
      let root = '';
      await f.inSource(async () => {
        await scheduleMessage(db, f.clock, f.userId, f.a.channelId, scheduled, {
          content: 'deferred A',
          sendAt,
        });
        const context = await requireChannelById(db, f.userId, f.b.channelId);
        root = (
          await sendMessage(db, f.clock, context, {
            id: messageId(f.clock.now()),
            content: 'remind B',
          })
        ).message.id;
        await setReminder(db, f.clock, f.userId, root, sendAt);
      });
      expect(
        await db
          .selectFrom('scheduled_messages')
          .select('source_session_id')
          .where('id', '=', scheduled)
          .executeTakeFirst(),
      ).toEqual({ source_session_id: f.source.sessionId });
      expect(
        await db
          .selectFrom('message_reminders')
          .select('source_session_id')
          .where('message_id', '=', root)
          .executeTakeFirst(),
      ).toEqual({ source_session_id: f.source.sessionId });
      const before = await activity(f);
      await endA(f);
      f.clock.advance(60_001);
      expect(
        await withinRequest(
          {
            requestId: 'unrelated-worker',
            startedAt: 0,
            sessionId: crypto.randomUUID(),
            workspaceAccess: () => Promise.resolve(),
          },
          async () =>
            await deliverScheduled({ ...f.dependencies, bus: PUSH_QUIET_BUS, log: NO_LOG }),
        ),
      ).toBe(0);
      expect(
        await db
          .selectFrom('scheduled_messages')
          .select(['state', 'failure_code'])
          .where('id', '=', scheduled)
          .executeTakeFirst(),
      ).toEqual({ state: 'failed', failure_code: 'WORKSPACE_ACCESS_REQUIRED' });
      expect(await deliverReminders({ ...f.dependencies, bus: PUSH_QUIET_BUS, log: NO_LOG })).toBe(
        1,
      );
      expect(await activity(f)).toEqual(before);
      expect(
        await db.selectFrom('messages').select('id').where('id', '=', scheduled).execute(),
      ).toEqual([]);
    });
  });

  test('prepared personal archive binds its original SID and exact included workspace set; account-only remains independent', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const ready = async (ids: string[] | null, source = f.source.sessionId): Promise<string> => {
        const id = messageId(f.clock.now());
        await db
          .insertInto('personal_exports')
          .values({
            id,
            user_id: f.userId,
            source_session_id: source,
            source_workspace_ids: ids,
            status: 'ready',
            storage_key: `private/${id}`,
            size_bytes: 1,
            created_at: f.clock.now(),
            heartbeat_at: f.clock.now(),
            expires_at: new Date(f.clock.now().getTime() + 86_400_000),
          })
          .execute();
        return id;
      };
      const a = await ready([f.a.workspaceId]);
      const b = await ready([f.b.workspaceId]);
      const account = await ready([]);
      await endA(f);
      expect(
        await claimPersonalDownload(db, f.clock, f.userId, a, f.dependencies).catch(
          (error: unknown) => error,
        ),
      ).toMatchObject({ body: { code: 'WORKSPACE_ACCESS_REQUIRED' } });
      expect(await claimPersonalDownload(db, f.clock, f.userId, b, f.dependencies)).toMatchObject({
        size: 1,
      });
      expect(
        await claimPersonalDownload(db, f.clock, f.userId, account, f.dependencies),
      ).toMatchObject({ size: 1 });
      const originalGone = await ready([]);
      await db
        .updateTable('sessions')
        .set({ revoked_at: f.clock.now() })
        .where('id', '=', f.source.sessionId)
        .execute();
      expect(
        await claimPersonalDownload(db, f.clock, f.userId, originalGone, f.dependencies).catch(
          (error: unknown) => error,
        ),
      ).toMatchObject({ body: { code: 'UNAUTHENTICATED' } });
      expect(
        await db
          .selectFrom('personal_exports')
          .select('status')
          .where('id', '=', a)
          .executeTakeFirst(),
      ).toEqual({ status: 'ready' });
    });
  });

  test('final projector handles controls, workspace hints, presence and exact company provenance; legacy archive metadata stays conservative', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const project = workspaceFrameProjector(db, f.clock, f.dependencies.sessionLifetime);
      const identity = { userId: f.userId, sessionId: f.source.sessionId };
      const signal = AbortSignal.timeout(3_000);
      const pong: ServerFrame = { event: 'PONG', ts: 1, data: {} };
      expect(await project(identity, [], pong, signal)).toEqual({ frame: pong });
      const ended: ServerFrame = { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 1 };
      expect(await project(identity, [], ended, signal)).toEqual({ frame: ended });
      const revoked: ServerFrame = {
        event: 'ACCESS_REVOKED',
        data: { channelIds: [f.a.channelId, f.b.channelId] },
        ts: 1,
      };
      expect(await project(identity, [], revoked, signal)).toEqual({ frame: revoked });
      for (const control of [
        { event: 'ACK', ts: 1, data: { id: messageId(f.clock.now()) } },
        { event: 'ERROR', ts: 1, data: { code: 'INTERNAL', message: 'failed' } },
      ] satisfies ServerFrame[])
        expect(await project(identity, [], control, signal)).toEqual({ frame: control });
      const hint: ServerFrame = {
        event: 'INBOX_UPDATED',
        ts: 1,
        data: { workspaceId: f.a.workspaceId },
      };
      expect(await project(identity, [], hint, signal)).toEqual({ frame: hint });
      for (const event of ['WORKSPACE_UPDATED', 'DEEP_WORK_UPDATED'] as const) {
        const update: ServerFrame =
          event === 'WORKSPACE_UPDATED'
            ? { event, ts: 1, data: { workspaceId: f.a.workspaceId } }
            : { event, ts: 1, data: { workspaceId: f.a.workspaceId, until: null } };
        expect(await project(identity, [], update, signal)).toEqual({ frame: update });
      }
      expect(
        await project(
          identity,
          [],
          { ...hint, data: { workspaceId: crypto.randomUUID() } },
          signal,
        ),
      ).toMatchObject({ channelIds: [] });
      expect(await project(identity, [], revised(crypto.randomUUID(), 'gone'), signal)).toEqual({
        frame: undefined,
      });
      const writer = f.a.members['writer'];
      if (writer === undefined) throw new Error('Missing presence peer');
      const changes = [
        { userId: writer.userId, online: true, away: false, version: 1 },
        { userId: crypto.randomUUID(), online: true, away: false, version: 1 },
      ];
      const presence: ServerFrame = { event: 'PRESENCE', ts: 1, data: { changes } };
      expect(await project(identity, [], presence, signal)).toMatchObject({
        frame: { data: { changes: [changes[0]] } },
      });
      await endA(f);
      expect(await project(identity, [], presence, signal)).toEqual({ frame: undefined });
      expect(await legacyPersonalWorkspaces(db).catch((error: unknown) => error)).toMatchObject({
        body: { code: 'EXPORT_NOT_FOUND' },
      });
      expect(
        await requirePreparedWorkspaceSet(db, f.userId, [f.b.workspaceId]).catch(
          (error: unknown) => error,
        ),
      ).toMatchObject({ body: { code: 'WORKSPACE_ACCESS_REQUIRED' } });
      expect(
        await requirePreparedWorkspaceSet(db, f.userId, [crypto.randomUUID()]).catch(
          (error: unknown) => error,
        ),
      ).toMatchObject({ body: { code: 'WORKSPACE_ACCESS_REQUIRED' } });
      const company = await companyWorkspaceMfaActor(
        {
          ...f.dependencies,
          lifetime: f.dependencies.sessionLifetime,
          cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
        },
        {
          context: await requireWorkspaceSecurityMembership(db, f.userId, f.a.workspaceId),
          sessionId: f.source.sessionId,
        },
      );
      const corporate = {
        ...identity,
        sessionId: company.actor.sessionId,
        companyWorkspaceId: f.a.workspaceId,
      };
      expect(await project(corporate, [], revoked, signal)).toEqual({
        frame: { ...revoked, data: { channelIds: [f.a.channelId] } },
      });
      expect(
        await project(corporate, [], { ...revoked, data: { channelIds: [f.b.channelId] } }, signal),
      ).toEqual({ frame: undefined });
      await withinDeferredSource(
        f.dependencies,
        { userId: f.userId, sessionId: company.actor.sessionId },
        async () => {
          expect(
            await requirePreparedWorkspaceSet(db, f.userId, [f.b.workspaceId]).catch(
              (error: unknown) => error,
            ),
          ).toMatchObject({ body: { code: 'WORKSPACE_ACCESS_REQUIRED' } });
        },
      );
      expect(
        await project(
          { ...identity, sessionId: company.actor.sessionId, companyWorkspaceId: f.a.workspaceId },
          [f.b.channelId],
          { ...hint, data: { workspaceId: f.b.workspaceId } },
          signal,
        ),
      ).toEqual({ frame: undefined });
      const legacy = await withinDeferredSource(
        f.dependencies,
        { userId: f.userId, sessionId: null },
        async () =>
          await db
            .selectFrom('workspaces')
            .select('id')
            .where('id', '=', f.a.workspaceId)
            .executeTakeFirst(),
      );
      expect(legacy).toBeDefined();
      const oldRoom = await aRoom(db, ['legacy-archive']);
      expect(await requirePreparedWorkspaceSet(db, f.userId, [oldRoom.workspaceId])).toBeDefined();
      const reset: ServerFrame = {
        event: 'WORKSPACE_UPDATED',
        ts: 1,
        data: { workspaceId: oldRoom.workspaceId, accessChanged: true },
      };
      expect(await project(identity, [], reset, signal)).toEqual({ restart: reset });
      f.clock.advance(3_600_001);
      expect(
        await withinDeferredSource(
          {
            ...f.dependencies,
            sessionLifetime: () => ({ sessionIdleTimeoutHours: 1, sessionMaxAgeDays: null }),
          },
          { userId: f.userId, sessionId: f.source.sessionId },
          () => Promise.resolve(),
        ).catch((error: unknown) => error),
      ).toMatchObject({ body: { code: 'UNAUTHENTICATED' } });
    });
  });

  test('personal snapshot excludes blocked A direct/link-only rows and retains B plus own account records', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await f.inSource(async () => {
        for (const room of [f.a, f.b])
          await sendMessage(db, f.clock, await requireChannelById(db, f.userId, room.channelId), {
            id: messageId(f.clock.now()),
            content: room.workspaceId === f.a.workspaceId ? 'blocked A words' : 'retained B words',
          });
      });
      await endA(f);
      const target = await mkdtemp(join(tmpdir(), 'purlay-delivery-person-'));
      try {
        const person = await db
          .selectFrom('users')
          .select('username')
          .where('id', '=', f.userId)
          .executeTakeFirstOrThrow();
        const result = await f.inSource(
          async () =>
            await exportPerson(
              {
                ...f.dependencies,
                log: NO_LOG,
                storage: aMemoryStore(),
                personalCatalogue: personalExportCatalogue,
              },
              { id: f.userId, username: person.username },
              join(target, 'archive'),
            ),
        );
        expect(result.workspaceIds).toEqual([f.b.workspaceId]);
        const messages = await readFile(join(result.path, 'messages.ndjson'), 'utf8');
        expect(messages).toContain('retained B words');
        expect(messages).not.toContain('blocked A words');
        const memberships = await readFile(join(result.path, 'channel_members.ndjson'), 'utf8');
        expect(memberships).toContain(f.b.channelId);
        expect(memberships).not.toContain(f.a.channelId);
        expect(await readFile(join(result.path, 'users.ndjson'), 'utf8')).toContain(f.userId);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });
  });

  test('the real personal job captures source at request and atomically publishes only its actual included workspace set', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const request = await f.inSource(
        async () => await requestPersonalExport(db, f.clock, f.userId),
      );
      await endA(f);
      const storage = aMemoryStore();
      await runPersonalExport(
        {
          ...f.dependencies,
          log: NO_LOG,
          storage,
          catalogue: exportCatalogue,
          personalCatalogue: personalExportCatalogue,
        },
        request.id,
      );
      const row = await db
        .selectFrom('personal_exports')
        .select(['status', 'source_session_id', 'source_workspace_ids', 'storage_key'])
        .where('id', '=', request.id)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        status: 'ready',
        source_session_id: f.source.sessionId,
        source_workspace_ids: [f.b.workspaceId],
      });
      expect(storage.keys()).toEqual([row.storage_key ?? '']);
      expect(row.storage_key).toMatch(new RegExp(`/exports/${request.id}/[0-9a-f-]+\\.tar$`));
      expect(
        await claimPersonalDownload(db, f.clock, f.userId, request.id, f.dependencies),
      ).toMatchObject({ key: row.storage_key });
    });
  });

  test('authority ending during real archive upload prevents READY and removes only its owned prepared object', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const request = await f.inSource(
        async () => await requestPersonalExport(db, f.clock, f.userId),
      );
      const storage = aMemoryStore();
      await runPersonalExport(
        {
          ...f.dependencies,
          log: NO_LOG,
          storage: {
            ...storage,
            putFile: async (key, path, type) => {
              await storage.putFile(key, path, type);
              await endA(f);
            },
          },
          catalogue: exportCatalogue,
          personalCatalogue: personalExportCatalogue,
        },
        request.id,
      );
      expect(
        await db
          .selectFrom('personal_exports')
          .select(['status', 'source_workspace_ids', 'storage_key'])
          .where('id', '=', request.id)
          .executeTakeFirst(),
      ).toEqual({ status: 'failed', source_workspace_ids: null, storage_key: null });
      expect(storage.keys()).toEqual([]);
    });
  });
});
