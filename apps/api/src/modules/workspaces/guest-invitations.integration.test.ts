/** Named admission uses real workspace roles, channel scope, recipient accounts and transactions. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback as rolledBack,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  type Transaction,
} from '@purlay/db';
import type { CreatedGuestInvitation } from '@purlay/types';
import { aRoom, type Room } from '../../testing/rooms';
import { aUserRow, type TestUser } from '../../testing/users';
import { attempt } from '../../testing/attempt';
import { fixedClock } from '../../platform/clock';
import { GUEST_CHANNELS_MAX } from '@purlay/types';
import { withinRequest } from '../../platform/logging';
import { effectiveModules } from '../../platform/module-kit/entitlement';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { createChannel } from '../../features/chat/channels/channels';
import { openConversation } from '../../features/chat/channels/direct-messages';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { noWorkspaceChannels, type WorkspaceChannels } from './channels-port';
import { createGuestInvitation } from './guest-invitations';
import {
  acceptInvitation,
  createInvitation,
  previewInvitation,
  revokeInvitation,
} from './invitations';
import { consumePassport, issuePassport, passportAllows } from './invitation-passport';
import { makeAndMailGuestInvitation, resendInvitationRecipient } from './invitation-mail';
import { finishInvitationAttempt } from './invitation-delivery';
import { admittedByPassport } from '../auth/better-auth';
import { INVITE_COOKIE } from '../../platform/cookies';
import { tokenDigest } from '../../platform/tokens';
import { changeRole, removeMember } from './members';
import { AppError } from '../../platform/errors';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const withRollback = async (work: (db: Transaction) => Promise<void>): Promise<void> => {
  await rolledBack(work, cloned.db);
};

const setup = async (
  db: Transaction,
): Promise<{
  readonly room: Room;
  readonly recipient: TestUser;
  readonly made: CreatedGuestInvitation;
}> => {
  const room = await aRoom(db, ['owner', 'member']);
  const recipient = await aUserRow(db, 'guest-recipient');
  await db
    .updateTable('users')
    .set({ email_verified: true })
    .where('id', '=', recipient.userId)
    .execute();
  const actor = await requireWorkspaceMembership(
    db,
    room.members['owner']?.userId ?? '',
    room.workspaceId,
  );
  const made = await createGuestInvitation(
    db,
    fixedClock(new Date()),
    actor,
    {
      email: recipient.email.toUpperCase(),
      channelIds: [room.channelId],
      accessExpiresAt: null,
    },
    chatWorkspaceChannels,
  );
  return { room, recipient, made };
};

describe('integration: named guest invitations', () => {
  test('creator removal after the invitation lookup is materialized is rechecked before admission', async () => {
    const clock = fixedClock(new Date());
    const { room, recipient, made } = await cloned.db.transaction().execute(async (db) => {
      const fixture = await setup(db);
      const creator = await requireWorkspaceMembership(
        db,
        fixture.room.members['owner']?.userId ?? '',
        fixture.room.workspaceId,
      );
      await changeRole(db, clock, creator, fixture.room.members['member']?.userId ?? '', 'owner');
      return fixture;
    });
    const selected = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let intercepted = false;
    const accepting = cloned.db
      .transaction()
      .execute(
        async (db) =>
          await acceptInvitation(
            db.withPlugin({
              transformQuery: (args) => args.node,
              transformResult: async (args) => {
                if (
                  !intercepted &&
                  args.result.rows.some((row) => row['invitation_id'] === made.invitation.id)
                ) {
                  intercepted = true;
                  selected.resolve(undefined);
                  await resume.promise;
                }
                return args.result;
              },
            }),
            clock,
            recipient.userId,
            made.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
      )
      .then(
        () => 'taken',
        (failure: unknown) =>
          failure instanceof AppError ? failure.body.code : 'unexpected failure',
      );
    await Promise.race([
      selected.promise,
      accepting.then(() => {
        throw new Error('Admission finished before the invitation read was held');
      }),
    ]);
    try {
      await cloned.db.transaction().execute(async (db) => {
        const successor = await requireWorkspaceMembership(
          db,
          room.members['member']?.userId ?? '',
          room.workspaceId,
        );
        await removeMember(
          db,
          clock,
          successor,
          room.members['owner']?.userId ?? '',
          chatWorkspaceChannels,
        );
      });
    } finally {
      resume.resolve(undefined);
    }
    expect(await accepting).toBe('INVITATION_NOT_FOUND');
    expect(
      await cloned.db
        .selectFrom('workspace_members')
        .select('id')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', recipient.userId)
        .execute(),
    ).toEqual([]);
    expect(
      await cloned.db
        .selectFrom('channel_members')
        .select('id')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', recipient.userId)
        .execute(),
    ).toEqual([]);
  });

  test('an invitation whose creator was removed cannot admit its named recipient or reveal the missing administrator', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      const clock = fixedClock(new Date());
      const creator = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const successorId = room.members['member']?.userId ?? '';
      await changeRole(db, clock, creator, successorId, 'owner');
      const successor = await requireWorkspaceMembership(db, successorId, room.workspaceId);
      await removeMember(db, clock, successor, creator.userId, chatWorkspaceChannels);
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            recipient.userId,
            made.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', room.channelId)
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('creation rechecks module access after the selected conversations were prepared', async () => {
    await withRollback(async (db) => {
      const { room, recipient } = await setup(db);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw new Error('Missing guest conversation port');
      let stopped = false;
      const channels: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...real,
          prepare: async (...args) => {
            await real.prepare(...args);
            stopped = true;
          },
        },
      };
      await withinRequest(
        {
          requestId: 'guest-entitlement-changed',
          startedAt: performance.now(),
          entitlements: {
            effective: (rows, now) =>
              effectiveModules({
                rows,
                now,
                mode: 'open',
                suspended: new Set(stopped ? ['chat'] : []),
                running: [{ id: 'chat', requires: [], entitlement: 'always' }],
              }),
            refused: () => undefined,
          },
        },
        async () => {
          expect(
            await attempt(db, () =>
              createGuestInvitation(
                db,
                fixedClock(new Date()),
                owner,
                { email: recipient.email, channelIds: [room.channelId], accessExpiresAt: null },
                channels,
              ),
            ),
          ).toBe('ROUTE_NOT_FOUND');
        },
      );
    });
  });

  test('the provider sign-up hook spends a guest cookie only for its named identity', async () => {
    await withRollback(async (db) => {
      const { recipient, made } = await setup(db);
      const clock = fixedClock(new Date());
      const { cookie } = await issuePassport(db, clock, { token: made.token });
      const context = {
        path: '/callback/google',
        headers: new Headers({ cookie: `${INVITE_COOKIE}=${cookie ?? ''}` }),
      };
      const wrong = await admittedByPassport(
        { database: db, clock },
        'another@example.test',
        context,
      ).catch((error: unknown) => error);
      expect(wrong).toMatchObject({ body: { code: 'signup_disabled' } });
      expect(await admittedByPassport({ database: db, clock }, recipient.email, context)).toBe(
        made.invitation.id,
      );
      const spent = await admittedByPassport(
        { database: db, clock },
        recipient.email,
        context,
      ).catch((error: unknown) => error);
      expect(spent).toMatchObject({ body: { code: 'signup_disabled' } });
    });
  });

  test('mailing and resending preserve named guest scope and independent copy links', async () => {
    await withRollback(async (db) => {
      const { room, recipient } = await setup(db);
      const clock = fixedClock(new Date());
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const mail = { on: true, appUrl: 'https://purlay.test' };
      const accessExpiresAt = new Date(clock.now().getTime() + 86_400_000).toISOString();
      const made = await makeAndMailGuestInvitation(
        db,
        clock,
        owner,
        {
          email: recipient.email,
          channelIds: [room.channelId],
          accessExpiresAt,
          locale: 'tr',
        },
        mail,
        chatWorkspaceChannels,
        true,
      );
      expect(made.created.guest).toEqual({
        email: recipient.email,
        channelIds: [room.channelId],
        accessExpiresAt,
      });
      expect(made.created.mail).toEqual([{ address: recipient.email, outcome: 'queued' }]);
      expect(made.letters).toHaveLength(1);
      const letter = made.letters[0];
      if (letter === undefined) throw new Error('Missing guest letter');
      expect(letter.to).toBe(recipient.email);
      expect(letter.text).toContain('yalnızca katıldıktan sonraki mesaj ve dosyaları');
      expect(letter.text).not.toContain('elinde olan herkes');
      const oldToken = /\/invite#([0-9a-f]{64})/.exec(letter.text)?.[1] ?? '';
      expect(oldToken).not.toBe(made.created.token);
      await finishInvitationAttempt(db, clock, letter.attemptId, { accepted: true });
      const attemptRow = await db
        .selectFrom('workspace_invitation_mail_attempts')
        .select('recipient_id')
        .where('id', '=', letter.attemptId)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('workspace_invitation_recipients')
        .set({ email: 'changed@example.test' })
        .where('id', '=', attemptRow.recipient_id)
        .execute();
      expect(
        await attempt(db, () =>
          resendInvitationRecipient(
            db,
            clock,
            owner,
            attemptRow.recipient_id,
            mail,
            chatWorkspaceChannels,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      await db
        .updateTable('workspace_invitation_recipients')
        .set({ email: recipient.email })
        .where('id', '=', attemptRow.recipient_id)
        .execute();
      expect(
        await attempt(db, () =>
          resendInvitationRecipient(db, clock, owner, attemptRow.recipient_id, mail),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      const again = await resendInvitationRecipient(
        db,
        clock,
        owner,
        attemptRow.recipient_id,
        mail,
        chatWorkspaceChannels,
      );
      const newToken = /\/invite#([0-9a-f]{64})/.exec(again.text)?.[1] ?? '';
      expect(newToken).not.toBe(oldToken);
      const stored = await db
        .selectFrom('workspace_invitations')
        .selectAll()
        .where('token_hash', '=', `guest:${await tokenDigest(newToken)}`)
        .executeTakeFirstOrThrow();
      expect(stored).toMatchObject({
        access_kind: 'guest',
        guest_email: recipient.email,
        guest_channels: [room.channelId],
        guest_modules: ['chat'],
      });
      expect(new Date(stored.guest_access_expires_at ?? 0).toISOString()).toBe(accessExpiresAt);
      expect(
        await attempt(db, () => previewInvitation(db, clock, recipient.userId, oldToken)),
      ).toBe('INVITATION_NOT_FOUND');
      expect(
        (await previewInvitation(db, clock, recipient.userId, made.created.token)).workspace.id,
      ).toBe(room.workspaceId);
      await acceptInvitation(
        db,
        clock,
        recipient.userId,
        newToken,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      expect(
        (await requireWorkspaceMembership(db, recipient.userId, room.workspaceId)).guest,
      ).toBeDefined();
    });
  });

  test('a guest sign-up passport stays bound to the named address, including a provider cookie', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      const clock = fixedClock(new Date());
      expect(
        await attempt(db, () =>
          issuePassport(db, clock, { token: made.token, email: 'another@example.test' }),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      await issuePassport(db, clock, { token: made.token, email: recipient.email.toUpperCase() });
      expect(await passportAllows(db, clock, { email: recipient.email })).toBeDefined();
      const { cookie } = await issuePassport(db, clock, { token: made.token });
      expect(cookie).toBeDefined();
      expect(await passportAllows(db, clock, { cookie })).toBeUndefined();
      expect(
        await passportAllows(db, clock, { cookie: undefined, email: recipient.email }),
      ).toBeUndefined();
      expect(
        await passportAllows(db, clock, { cookie, email: 'another@example.test' }),
      ).toBeUndefined();
      const id = await passportAllows(db, clock, { cookie, email: recipient.email.toUpperCase() });
      expect(id).toBeDefined();
      if (id === undefined) throw new Error('The named recipient needs an admission passport');
      await db
        .updateTable('users')
        .set({ suspended_at: clock.now() })
        .where('id', '=', room.members['owner']?.userId ?? '')
        .execute();
      expect(await passportAllows(db, clock, { cookie, email: recipient.email })).toBeUndefined();
      expect(await consumePassport(db, id, clock)).toBe(false);
    });
  });

  test('subsequent grants cannot grow a guest past the total channel bound', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      const clock = fixedClock(new Date());
      await acceptInvitation(
        db,
        clock,
        recipient.userId,
        made.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const channels = await db
        .insertInto('channels')
        .values(
          Array.from({ length: GUEST_CHANNELS_MAX }, (_, index) => ({
            workspace_id: room.workspaceId,
            name: `guest-scope-${String(index)}`,
            type: 'public' as const,
          })),
        )
        .returning('id')
        .execute();
      const port = chatWorkspaceChannels.guests;
      if (port === undefined) throw new Error('Missing guest channel port');
      await port.grant(
        db,
        clock,
        owner,
        recipient.userId,
        channels.slice(0, -1).map((row) => row.id),
      );
      expect(
        await attempt(db, () =>
          port.grant(db, clock, owner, recipient.userId, [channels.at(-1)?.id ?? '']),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await db
          .selectFrom('channel_members')
          .select('channel_id')
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toHaveLength(GUEST_CHANNELS_MAX);
    });
  });

  test('a selected channel stays locked until invitation creation commits', async () => {
    const { room, recipient } = await cloned.db
      .transaction()
      .execute(async (db) => await setup(db));
    const real = chatWorkspaceChannels.guests;
    if (real === undefined) throw new Error('Missing guest channel port');
    const prepared = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const ports: WorkspaceChannels = {
      ...chatWorkspaceChannels,
      guests: {
        ...real,
        prepare: async (...args) => {
          await real.prepare(...args);
          prepared.resolve(undefined);
          await resume.promise;
        },
      },
    };
    const clock = fixedClock(new Date());
    const creating = cloned.db.transaction().execute(async (db) => {
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      return await createGuestInvitation(
        db,
        clock,
        owner,
        { email: recipient.email, channelIds: [room.channelId], accessExpiresAt: null },
        ports,
      );
    });
    let archiving: Promise<void> | undefined;
    try {
      await Promise.race([
        prepared.promise,
        creating.then(() => {
          throw new Error('Creation skipped channel preparation');
        }),
      ]);
      const archivePid = Promise.withResolvers<number>();
      const archived = { value: false };
      archiving = cloned.db.transaction().execute(async (db) => {
        const row = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        const pid = row.rows[0]?.pid;
        if (pid === undefined) throw new Error('Missing archive connection');
        archivePid.resolve(pid);
        await db
          .updateTable('channels')
          .set({ deleted_at: clock.now() })
          .where('id', '=', room.channelId)
          .execute();
        archived.value = true;
      });
      const pid = await Promise.race([
        archivePid.promise,
        archiving.then(() => {
          throw new Error('Archive had no connection');
        }),
      ]);
      let waiting = false;
      const deadline = Date.now() + 3_000;
      while (!waiting && !archived.value && Date.now() < deadline) {
        const result = await sql<{ waiting: boolean }>`select wait_event_type = 'Lock' as waiting
          from pg_stat_activity where pid = ${pid}`.execute(cloned.db);
        waiting = result.rows[0]?.waiting === true;
        if (!waiting) await Bun.sleep(5);
      }
      expect(waiting).toBe(true);
    } finally {
      resume.resolve(undefined);
      await Promise.allSettled([creating, ...(archiving === undefined ? [] : [archiving])]);
    }
    expect((await creating).guest.channelIds).toEqual([room.channelId]);
  });

  test('the channel port independently refuses ordinary actors, full-member targets and a stopped chat module', async () => {
    await withRollback(async (db) => {
      const { room } = await setup(db);
      const ports = chatWorkspaceChannels.guests;
      if (ports === undefined) throw new Error('Missing chat guest port');
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const member = await requireWorkspaceMembership(
        db,
        room.members['member']?.userId ?? '',
        room.workspaceId,
      );
      expect(await attempt(db, () => ports.prepare(db, member, [room.channelId]))).toBe(
        'FORBIDDEN',
      );
      expect(
        await attempt(db, () =>
          ports.grant(db, fixedClock(new Date()), owner, member.userId, [room.channelId]),
        ),
      ).toBe('FORBIDDEN');
      expect(await attempt(db, () => ports.prepare(db, owner, []))).toBe('VALIDATION_FAILED');
      await withinRequest(
        {
          requestId: 'guest-chat-stopped',
          startedAt: performance.now(),
          entitlements: {
            effective: (rows, now) =>
              effectiveModules({
                rows,
                now,
                mode: 'open',
                suspended: new Set(['chat']),
                running: [{ id: 'chat', requires: [], entitlement: 'always' }],
              }),
            refused: () => undefined,
          },
        },
        async () => {
          expect(await attempt(db, () => ports.prepare(db, owner, [room.channelId]))).toBe(
            'ROUTE_NOT_FOUND',
          );
        },
      );
    });
  });

  test('revocation, expiry, archived channels, missing support and a demoted inviter all refuse admission', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const clock = fixedClock(new Date());
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            recipient.userId,
            made.token,
            undefined,
            noWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      await revokeInvitation(db, clock, owner, made.invitation.id);
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            recipient.userId,
            made.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      const request = {
        email: recipient.email,
        channelIds: [room.channelId],
        accessExpiresAt: null,
      };
      const expiring = await createGuestInvitation(
        db,
        clock,
        owner,
        { ...request, accessExpiresAt: new Date(clock.now().getTime() + 1_000).toISOString() },
        chatWorkspaceChannels,
      );
      await db
        .updateTable('workspace_invitations')
        .set({ expires_at: new Date(clock.now().getTime() + 86_400_000) })
        .where('id', '=', expiring.invitation.id)
        .execute();
      expect(
        await attempt(db, () =>
          previewInvitation(
            db,
            fixedClock(new Date(clock.now().getTime() + 1_000)),
            recipient.userId,
            expiring.token,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            fixedClock(new Date(clock.now().getTime() + 1_000)),
            recipient.userId,
            expiring.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      const archived = await createGuestInvitation(
        db,
        clock,
        owner,
        request,
        chatWorkspaceChannels,
      );
      await db
        .updateTable('channels')
        .set({ deleted_at: clock.now() })
        .where('id', '=', room.channelId)
        .execute();
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            recipient.userId,
            archived.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      await db
        .updateTable('channels')
        .set({ deleted_at: null })
        .where('id', '=', room.channelId)
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ role: 'owner' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', room.members['member']?.userId ?? '')
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ role: 'member' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', owner.userId)
        .execute();
      expect(
        await attempt(db, () => previewInvitation(db, clock, recipient.userId, archived.token)),
      ).toBe('INVITATION_NOT_FOUND');
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('another guest invitation and a normal invite do not broaden an existing guest', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      const clock = fixedClock(new Date());
      const first = await acceptInvitation(
        db,
        clock,
        recipient.userId,
        made.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const another = await createChannel(db, clock, owner, { name: 'not-in-the-original-grant' });
      const broader = await createGuestInvitation(
        db,
        clock,
        owner,
        { email: recipient.email, channelIds: [another.id], accessExpiresAt: null },
        chatWorkspaceChannels,
      );
      const normal = await createInvitation(db, clock, owner);
      for (const token of [broader.token, normal.token]) {
        const accepted = await acceptInvitation(
          db,
          clock,
          recipient.userId,
          token,
          undefined,
          chatWorkspaceChannels,
          true,
        );
        expect(accepted.membership).toEqual(first.membership);
        expect(accepted.memberIds).toEqual([]);
      }
      expect(
        await db
          .selectFrom('channel_members')
          .select('channel_id')
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([{ channel_id: room.channelId }]);
    });
  });

  test('an existing full member keeps their role when accepting a guest invitation', async () => {
    await withRollback(async (db) => {
      const { room } = await setup(db);
      const clock = fixedClock(new Date());
      const memberId = room.members['member']?.userId ?? '';
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', memberId)
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', memberId)
        .execute();
      const user = await db
        .selectFrom('users')
        .select('email')
        .where('id', '=', memberId)
        .executeTakeFirstOrThrow();
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const invite = await createGuestInvitation(
        db,
        clock,
        owner,
        { email: user.email, channelIds: [room.channelId], accessExpiresAt: null },
        chatWorkspaceChannels,
      );
      const accepted = await acceptInvitation(
        db,
        clock,
        memberId,
        invite.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      expect(accepted.membership.role).toBe('admin');
      expect(accepted.membership.access).toBeUndefined();
      expect(accepted.memberIds).toEqual([]);
    });
  });

  test('an audit failure rolls back both membership and channel grants', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      await sql`create function reject_guest_join_audit() returns trigger language plpgsql as $$
        begin if new.action = 'member.joined' then raise exception 'guest audit failure'; end if; return new; end $$`.execute(
        db,
      );
      await sql`create trigger reject_guest_join_audit before insert on audit_log for each row execute function reject_guest_join_audit()`.execute(
        db,
      );
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            fixedClock(new Date()),
            recipient.userId,
            made.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toContain('guest audit failure');
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('channel_members')
          .select('channel_id')
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('two committed accepts produce one guest membership and one join audit', async () => {
    const { room, recipient, made } = await cloned.db
      .transaction()
      .execute(async (db) => await setup(db));
    const clock = fixedClock(new Date());
    const outcomes = await Promise.all(
      [0, 1].map(
        async () =>
          await cloned.db
            .transaction()
            .execute(
              async (db) =>
                await acceptInvitation(
                  db,
                  clock,
                  recipient.userId,
                  made.token,
                  undefined,
                  chatWorkspaceChannels,
                  true,
                ),
            ),
      ),
    );
    expect(outcomes[0]?.membership).toEqual(outcomes[1]?.membership);
    expect(outcomes.map((result) => result.memberIds.length > 0).sort()).toEqual([false, true]);
    expect(
      await cloned.db
        .selectFrom('audit_log')
        .select('id')
        .where('workspace_id', '=', room.workspaceId)
        .where('target_id', '=', recipient.userId)
        .where('action', '=', 'member.joined')
        .execute(),
    ).toHaveLength(1);
  });

  test('creation stores a restricted digest and selected channels without admitting anybody', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      expect(made.guest).toEqual({
        email: recipient.email,
        channelIds: [room.channelId],
        accessExpiresAt: null,
      });
      const row = await db
        .selectFrom('workspace_invitations')
        .selectAll()
        .where('id', '=', made.invitation.id)
        .executeTakeFirstOrThrow();
      expect(row.access_kind).toBe('guest');
      expect(row.token_hash.startsWith('guest:')).toBe(true);
      expect(row.guest_modules).toEqual(['chat']);
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('members, invalid dates, foreign or invisible private channels and DMs cannot create guest invitations', async () => {
    await withRollback(async (db) => {
      const { room, recipient } = await setup(db);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const member = await requireWorkspaceMembership(
        db,
        room.members['member']?.userId ?? '',
        room.workspaceId,
      );
      const request = {
        email: recipient.email,
        channelIds: [room.channelId],
        accessExpiresAt: null,
      };
      expect(
        await attempt(db, () =>
          createGuestInvitation(db, fixedClock(new Date()), member, request, chatWorkspaceChannels),
        ),
      ).toBe('FORBIDDEN');
      expect(
        await attempt(db, () =>
          createGuestInvitation(db, fixedClock(new Date()), member, request, noWorkspaceChannels),
        ),
      ).toBe('FORBIDDEN');
      const tampered = { ...request, role: 'owner' };
      expect(
        await attempt(db, () =>
          createGuestInvitation(db, fixedClock(new Date()), owner, tampered, chatWorkspaceChannels),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await attempt(db, () =>
          createGuestInvitation(
            db,
            fixedClock(new Date()),
            owner,
            { ...request, accessExpiresAt: '2000-01-01T00:00:00.000Z' },
            chatWorkspaceChannels,
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await attempt(db, () =>
          createGuestInvitation(db, fixedClock(new Date()), owner, request, noWorkspaceChannels),
        ),
      ).toBe('ROUTE_NOT_FOUND');
      const privateChannel = await createChannel(db, fixedClock(new Date()), member, {
        name: 'not-the-owner-s',
        type: 'private',
      });
      const dm = await openConversation(db, fixedClock(new Date()), owner, [member.userId]);
      const foreign = await aRoom(db, ['elsewhere']);
      // Visibility in a second workspace still does not make it a grant in this workspace.
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: foreign.workspaceId, user_id: owner.userId, role: 'admin' })
        .execute();
      for (const channelId of [privateChannel.id, dm.channel.id, foreign.channelId])
        expect(
          await attempt(db, () =>
            createGuestInvitation(
              db,
              fixedClock(new Date()),
              owner,
              { ...request, channelIds: [channelId] },
              chatWorkspaceChannels,
            ),
          ),
        ).toBe('CHANNEL_NOT_FOUND');
    });
  });

  test('only the verified recipient is admitted, into the selected channels, once', async () => {
    await withRollback(async (db) => {
      const { room, recipient, made } = await setup(db);
      const other = await aUserRow(db, 'wrong-recipient');
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', other.userId)
        .execute();
      const clock = fixedClock(new Date());
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            other.userId,
            made.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      await db
        .updateTable('users')
        .set({ email_verified: false })
        .where('id', '=', recipient.userId)
        .execute();
      expect(
        await attempt(db, () =>
          acceptInvitation(
            db,
            clock,
            recipient.userId,
            made.token,
            undefined,
            chatWorkspaceChannels,
            true,
          ),
        ),
      ).toBe('INVITATION_NOT_FOUND');
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', recipient.userId)
        .execute();
      const accepted = await acceptInvitation(
        db,
        clock,
        recipient.userId,
        made.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      expect(accepted.membership.access?.kind).toBe('guest');
      expect(accepted.membership.modules).toEqual(['chat']);
      expect(
        await db
          .selectFrom('channel_members')
          .select('channel_id')
          .where('user_id', '=', recipient.userId)
          .execute(),
      ).toEqual([{ channel_id: room.channelId }]);
      const again = await acceptInvitation(
        db,
        clock,
        recipient.userId,
        made.token,
        undefined,
        chatWorkspaceChannels,
        true,
      );
      expect(again.membership).toEqual(accepted.membership);
      expect(again.memberIds).toEqual([]);
    });
  });
});
