/** Real sends racing guest invitation work must finish and preserve the first unread baseline. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  type Transaction,
} from '@purlay/db';
import { messageId, type CreatedGuestInvitation } from '@purlay/types';
import { aMovableClock } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireChannelById } from '../../features/chat/channels/guard';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { sendMessage, messageHistory } from '../../features/chat/messages/messages';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { aUserRow, type TestUser } from '../../testing/users';
import { createGuestInvitation } from './guest-invitations';
import { acceptInvitation, createInvitation } from './invitations';
import { AppError } from '../../platform/errors';
import type { WorkspaceChannels } from './channels-port';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const waitsFor = async (pid: number, blocker: number): Promise<boolean> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await sql<{
      blockers: number[];
    }>`select pg_blocking_pids(${pid}) as blockers`.execute(cloned.db);
    if (result.rows[0]?.blockers.includes(blocker) === true) return true;
    await Bun.sleep(5);
  }
  return false;
};

const failureCode = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'non-database failure';

const setup = async (
  at = new Date(),
): Promise<{ room: Room; recipient: TestUser; invitation: CreatedGuestInvitation; at: Date }> =>
  await cloned.db.transaction().execute(async (db) => {
    const room = await aRoom(db, ['owner']);
    const recipient = await aUserRow(db, 'racing-guest');
    await db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', recipient.userId)
      .execute();
    const owner = await requireWorkspaceMembership(
      db,
      room.members['owner']?.userId ?? '',
      room.workspaceId,
    );
    const invitation = await createGuestInvitation(
      db,
      fixedClock(at),
      owner,
      { email: recipient.email, channelIds: [room.channelId], accessExpiresAt: null },
      chatWorkspaceChannels,
    );
    return { room, recipient, invitation, at };
  });

describe('integration: guest admission and simultaneous sends', () => {
  test.each(['guest-invitation', 'member-invitation', 'guest-access'] as const)(
    '%s expiry while waiting on the workspace lock refuses admission',
    async (kind) => {
      const { room, recipient, invitation, at } = await setup(new Date(Date.now() - 2_000));
      const clock = aMovableClock(at);
      const target =
        kind === 'member-invitation'
          ? await cloned.db
              .transaction()
              .execute(
                async (db) =>
                  await createInvitation(
                    db,
                    clock,
                    await requireWorkspaceMembership(
                      db,
                      room.members['owner']?.userId ?? '',
                      room.workspaceId,
                    ),
                  ),
              )
          : invitation;
      await cloned.db
        .updateTable('workspace_invitations')
        .set(
          kind !== 'guest-access'
            ? { expires_at: new Date(at.getTime() + 500) }
            : {
                expires_at: new Date(at.getTime() + 60_000),
                guest_access_expires_at: new Date(at.getTime() + 500),
              },
        )
        .where('id', '=', target.invitation.id)
        .execute();
      const held = Promise.withResolvers<number>();
      const release = Promise.withResolvers<undefined>();
      const holding = cloned.db.transaction().execute(async (db) => {
        const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db)).rows[0]
          ?.pid;
        if (pid === undefined) throw new Error('Missing workspace holder connection');
        await db
          .selectFrom('workspaces')
          .select('id')
          .where('id', '=', room.workspaceId)
          .forUpdate()
          .execute();
        held.resolve(pid);
        await release.promise;
      });
      let accepting: Promise<string> | undefined;
      try {
        const blocker = await Promise.race([
          held.promise,
          holding.then(() => {
            throw new Error('Workspace was not locked');
          }),
        ]);
        const connection = Promise.withResolvers<number>();
        accepting = cloned.db
          .transaction()
          .execute(async (db) => {
            await sql`set local lock_timeout = '4s'`.execute(db);
            const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db))
              .rows[0]?.pid;
            if (pid === undefined) throw new Error('Missing guest acceptance connection');
            connection.resolve(pid);
            await acceptInvitation(
              db,
              clock,
              recipient.userId,
              target.token,
              undefined,
              chatWorkspaceChannels,
              true,
            );
          })
          .then(
            () => 'accepted',
            (error: unknown) => (error instanceof AppError ? error.body.code : failureCode(error)),
          );
        const pid = await Promise.race([
          connection.promise,
          accepting.then(() => {
            throw new Error('Guest acceptance had no connection');
          }),
        ]);
        expect(await Promise.race([waitsFor(pid, blocker), accepting.then(() => false)])).toBe(
          true,
        );
        clock.advance(1_000);
      } finally {
        release.resolve(undefined);
        await Promise.allSettled([holding, ...(accepting === undefined ? [] : [accepting])]);
      }
      expect(await accepting).toBe('INVITATION_NOT_FOUND');
    },
    10_000,
  );

  test.each(['expiry', 'join-time'] as const)(
    'acceptance uses the clock after channel preparation: %s',
    async (boundary) => {
      const { room, recipient, invitation, at } = await setup(new Date(Date.now() - 2_000));
      const clock = aMovableClock(at);
      if (boundary === 'expiry')
        await cloned.db
          .updateTable('workspace_invitations')
          .set({ expires_at: new Date(at.getTime() + 500) })
          .where('id', '=', invitation.invitation.id)
          .execute();
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw new Error('Missing guest conversation adapter');
      const prepared = Promise.withResolvers<undefined>();
      const resume = Promise.withResolvers<undefined>();
      const channels: WorkspaceChannels = {
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
      const accepting = cloned.db
        .transaction()
        .execute(
          async (db) =>
            await acceptInvitation(
              db,
              clock,
              recipient.userId,
              invitation.token,
              undefined,
              channels,
              true,
            ),
        );
      try {
        await Promise.race([
          prepared.promise,
          accepting.then(() => {
            throw new Error('Acceptance skipped preparation');
          }),
        ]);
        clock.advance(1_000);
      } finally {
        resume.resolve(undefined);
      }
      const outcome = await accepting.then(
        (result) => result.membership,
        (error: unknown) => (error instanceof AppError ? error.body.code : failureCode(error)),
      );
      if (boundary === 'expiry') {
        expect(outcome).toBe('INVITATION_NOT_FOUND');
        expect(
          await cloned.db
            .selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', room.workspaceId)
            .where('user_id', '=', recipient.userId)
            .execute(),
        ).toEqual([]);
      } else {
        expect(outcome).toMatchObject({
          joinedAt: clock.now().toISOString(),
          access: { kind: 'guest', historySince: clock.now().toISOString() },
        });
      }
    },
  );

  test.each(['create', 'accept'] as const)(
    '%s and a send both finish with a correct readable baseline',
    async (operation) => {
      const { room, recipient, invitation, at } = await setup();
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw new Error('Missing guest conversation adapter');
      const prepared = Promise.withResolvers<number>();
      const resume = Promise.withResolvers<undefined>();
      let held = false;
      const channels: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...real,
          prepare: async (...args) => {
            await real.prepare(...args);
            if (!held) {
              held = true;
              const pid = (
                await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(args[0])
              ).rows[0]?.pid;
              if (pid === undefined) throw new Error('Missing admission connection');
              prepared.resolve(pid);
              await resume.promise;
            }
          },
        },
      };
      const inviteWork = cloned.db.transaction().execute(async (db) => {
        await sql`set local lock_timeout = '4s'`.execute(db);
        if (operation === 'accept')
          return await acceptInvitation(
            db,
            fixedClock(at),
            recipient.userId,
            invitation.token,
            undefined,
            channels,
            true,
          );
        const owner = await requireWorkspaceMembership(
          db,
          room.members['owner']?.userId ?? '',
          room.workspaceId,
        );
        return await createGuestInvitation(
          db,
          fixedClock(at),
          owner,
          { email: recipient.email, channelIds: [room.channelId], accessExpiresAt: null },
          channels,
        );
      });
      let sending: Promise<Awaited<ReturnType<typeof sendMessage>>> | undefined;
      try {
        const blocker = await Promise.race([
          prepared.promise,
          inviteWork.then(() => {
            throw new Error('Guest work skipped conversation preparation');
          }),
        ]);
        const senderPid = Promise.withResolvers<number>();
        sending = cloned.db.transaction().execute(async (db: Transaction) => {
          await sql`set local lock_timeout = '4s'`.execute(db);
          const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db))
            .rows[0]?.pid;
          if (pid === undefined) throw new Error('Missing sender connection');
          senderPid.resolve(pid);
          const context = await requireChannelById(
            db,
            room.members['owner']?.userId ?? '',
            room.channelId,
          );
          const sentAt = new Date(at.getTime() + 10);
          return await sendMessage(db, fixedClock(sentAt), context, {
            id: messageId(sentAt),
            content: 'A message written after the guest join instant',
          });
        });
        const pid = await Promise.race([
          senderPid.promise,
          sending.then(() => {
            throw new Error('Send completed without its connection');
          }),
        ]);
        const waiting = await Promise.race([
          waitsFor(pid, blocker),
          sending.then(
            () => false,
            () => false,
          ),
        ]);
        expect(waiting).toBe(true);
      } finally {
        resume.resolve(undefined);
        const outcomes = await Promise.allSettled([
          inviteWork,
          ...(sending === undefined ? [] : [sending]),
        ]);
        expect(
          outcomes.flatMap((outcome) =>
            outcome.status === 'rejected' ? [failureCode(outcome.reason)] : [],
          ),
        ).toEqual([]);
      }
      const sent = await sending;
      if (operation === 'accept') {
        const guest = await requireChannelById(cloned.db, recipient.userId, room.channelId);
        const history = await messageHistory(cloned.db, guest, {});
        expect(history.data.map((row) => row.id)).toEqual([sent.message.id]);
        expect(await counters(cloned.db, room, recipient.userId)).toMatchObject({
          unread: 1,
          mentions: 0,
        });
      }
    },
    10_000,
  );
});
