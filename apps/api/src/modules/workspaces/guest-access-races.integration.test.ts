/** Independent transactions prove guest edit locks, initial unread counts and stale administrator edits. */
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
import { messageId } from '@purlay/types';
import { aMovableClock } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireChannelById } from '../../features/chat/channels/guard';
import { createChannel } from '../../features/chat/channels/channels';
import { chatWorkspaceChannels } from '../../features/chat/channels/workspace-channels';
import { sendMessage, messageHistory } from '../../features/chat/messages/messages';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { aUserRow, type TestUser } from '../../testing/users';
import { createGuestInvitation } from './guest-invitations';
import { acceptInvitation } from './invitations';
import { updateGuestAccess } from './guest-access';
import { changeRole } from './members';
import type { WorkspaceChannels } from './channels-port';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const codeOf = (error: unknown): string =>
  error instanceof AppError
    ? error.body.code
    : error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unexpected failure';

const pidOf = async (db: Transaction): Promise<number> => {
  const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db)).rows[0]?.pid;
  if (pid === undefined) throw new Error('Missing transaction connection');
  return pid;
};

/** A real PG wait is observed; an already completed operation cannot count as waiting. */
const waitsFor = async (pid: number, blocker: number, work: Promise<unknown>): Promise<boolean> => {
  const progress = { settled: false };
  void work.then(
    () => {
      progress.settled = true;
    },
    () => {
      progress.settled = true;
    },
  );
  const deadline = Date.now() + 3_000;
  while (!progress.settled && Date.now() < deadline) {
    const result = await sql<{
      blockers: number[];
    }>`select pg_blocking_pids(${pid}) as blockers`.execute(cloned.db);
    if (result.rows[0]?.blockers.includes(blocker) === true) return true;
    await Bun.sleep(5);
  }
  return false;
};

const setup = async (): Promise<{ room: Room; guest: TestUser; at: Date }> =>
  await cloned.db.transaction().execute(async (db) => {
    const room = await aRoom(db, ['owner', 'admin']);
    const at = new Date(Date.now() - 2_000);
    const owner = await requireWorkspaceMembership(
      db,
      room.members['owner']?.userId ?? '',
      room.workspaceId,
    );
    await changeRole(db, fixedClock(at), owner, room.members['admin']?.userId ?? '', 'admin');
    const guest = await aUserRow(db, 'editing-guest');
    await db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', guest.userId)
      .execute();
    const invitation = await createGuestInvitation(
      db,
      fixedClock(at),
      owner,
      { email: guest.email, channelIds: [room.channelId], accessExpiresAt: null },
      chatWorkspaceChannels,
    );
    await acceptInvitation(
      db,
      fixedClock(at),
      guest.userId,
      invitation.token,
      undefined,
      chatWorkspaceChannels,
      true,
    );
    return { room, guest, at };
  });

describe('integration: guest access edits and independent writers', () => {
  test.each(['grant', 'reactivate', 'revoke'] as const)(
    '%s holds overlapping sends until scope and counters commit',
    async (operation) => {
      const { room, guest, at } = await setup();
      const channelId =
        operation === 'grant'
          ? await cloned.db
              .transaction()
              .execute(
                async (db) =>
                  (
                    await createChannel(
                      db,
                      fixedClock(new Date()),
                      await requireWorkspaceMembership(
                        db,
                        room.members['owner']?.userId ?? '',
                        room.workspaceId,
                      ),
                      { name: 'new-conversation', type: 'public' },
                    )
                  ).id,
              )
          : room.channelId;
      if (operation === 'reactivate') {
        await cloned.db
          .updateTable('workspace_members')
          .set({ guest_expires_at: new Date(at.getTime() + 1_000) })
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', guest.userId)
          .execute();
        await cloned.db
          .updateTable('channel_members')
          .set({ unread_count: 7, unread_mention_count: 2 })
          .where('channel_id', '=', channelId)
          .where('user_id', '=', guest.userId)
          .execute();
      }
      const real = chatWorkspaceChannels.guests;
      if (real === undefined) throw new Error('Missing guest conversation adapter');
      const prepared = Promise.withResolvers<number>();
      const resume = Promise.withResolvers<undefined>();
      const channels: WorkspaceChannels = {
        ...chatWorkspaceChannels,
        guests: {
          ...real,
          prepareEdit: async (...args) => {
            const edit = await real.prepareEdit(...args);
            prepared.resolve(await pidOf(args[0]));
            await resume.promise;
            return edit;
          },
        },
      };
      const editedAt = new Date();
      const editing = cloned.db.transaction().execute(async (db) => {
        await sql`set local lock_timeout = '4s'`.execute(db);
        return await updateGuestAccess(
          db,
          fixedClock(editedAt),
          await requireWorkspaceMembership(
            db,
            room.members['owner']?.userId ?? '',
            room.workspaceId,
          ),
          guest.userId,
          operation === 'grant'
            ? { channelIds: [room.channelId, channelId] }
            : operation === 'reactivate'
              ? { accessExpiresAt: null }
              : { channelIds: [] },
          channels,
          true,
        );
      });
      let sending: Promise<Awaited<ReturnType<typeof sendMessage>>> | undefined;
      try {
        const blocker = await Promise.race([
          prepared.promise,
          editing.then(() => {
            throw new Error('Edit skipped preparation');
          }),
        ]);
        const sender = Promise.withResolvers<number>();
        sending = cloned.db.transaction().execute(async (db) => {
          await sql`set local lock_timeout = '4s'`.execute(db);
          sender.resolve(await pidOf(db));
          const context = await requireChannelById(
            db,
            room.members['owner']?.userId ?? '',
            channelId,
          );
          const sentAt = new Date(editedAt.getTime() + 10);
          return await sendMessage(db, fixedClock(sentAt), context, {
            id: messageId(sentAt),
            content: 'After the guest access edit',
          });
        });
        const pid = await Promise.race([
          sender.promise,
          sending.then(() => {
            throw new Error('Send skipped its connection');
          }),
        ]);
        expect(await waitsFor(pid, blocker, sending)).toBe(true);
      } finally {
        resume.resolve(undefined);
        const outcomes = await Promise.allSettled([
          editing,
          ...(sending === undefined ? [] : [sending]),
        ]);
        expect(
          outcomes.flatMap((outcome) =>
            outcome.status === 'rejected' ? [codeOf(outcome.reason)] : [],
          ),
        ).toEqual([]);
      }
      const sent = await sending;
      if (operation === 'revoke') {
        expect(
          await requireChannelById(cloned.db, guest.userId, channelId).then(
            () => 'visible',
            codeOf,
          ),
        ).toBe('CHANNEL_NOT_FOUND');
        expect(
          await cloned.db
            .selectFrom('channel_members')
            .select('id')
            .where('channel_id', '=', channelId)
            .where('user_id', '=', guest.userId)
            .execute(),
        ).toEqual([]);
      } else {
        const context = await requireChannelById(cloned.db, guest.userId, channelId);
        expect((await messageHistory(cloned.db, context, {})).data.map((row) => row.id)).toEqual([
          sent.message.id,
        ]);
        expect(await counters(cloned.db, { ...room, channelId }, guest.userId)).toMatchObject({
          unread: 1,
          mentions: 0,
        });
      }
    },
    10_000,
  );

  test('expiry is rechecked after the real workspace mutex wait', async () => {
    const { room, guest, at } = await setup();
    const clock = aMovableClock(at);
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<undefined>();
    const holding = cloned.db.transaction().execute(async (db) => {
      const pid = await pidOf(db);
      await db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', room.workspaceId)
        .forUpdate()
        .execute();
      held.resolve(pid);
      await release.promise;
    });
    let editing: Promise<string> | undefined;
    try {
      const blocker = await Promise.race([
        held.promise,
        holding.then(() => {
          throw new Error('Workspace was not locked');
        }),
      ]);
      const connection = Promise.withResolvers<number>();
      editing = cloned.db
        .transaction()
        .execute(async (db) => {
          await sql`set local lock_timeout = '4s'`.execute(db);
          connection.resolve(await pidOf(db));
          await updateGuestAccess(
            db,
            clock,
            await requireWorkspaceMembership(
              db,
              room.members['owner']?.userId ?? '',
              room.workspaceId,
            ),
            guest.userId,
            { accessExpiresAt: new Date(at.getTime() + 500).toISOString() },
            chatWorkspaceChannels,
            true,
          );
        })
        .then(() => 'changed', codeOf);
      const pid = await Promise.race([
        connection.promise,
        editing.then(() => {
          throw new Error('Edit had no connection');
        }),
      ]);
      expect(await waitsFor(pid, blocker, editing)).toBe(true);
      clock.advance(1_000);
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([holding, ...(editing === undefined ? [] : [editing])]);
    }
    expect(await editing).toBe('VALIDATION_FAILED');
    const target = await cloned.db
      .selectFrom('workspace_members')
      .select('guest_expires_at')
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', guest.userId)
      .executeTakeFirstOrThrow();
    expect(target.guest_expires_at).toBeNull();
  }, 10_000);

  test('a second administrator refreshes after waiting rather than removing a grant it never locked', async () => {
    const { room, guest } = await setup();
    const [firstChannel, secondChannel] = await cloned.db.transaction().execute(async (db) => {
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      return [
        await createChannel(db, fixedClock(new Date()), owner, {
          name: 'first-edit',
          type: 'public',
        }),
        await createChannel(db, fixedClock(new Date()), owner, {
          name: 'second-edit',
          type: 'public',
        }),
      ] as const;
    });
    const real = chatWorkspaceChannels.guests;
    if (real === undefined) throw new Error('Missing guest conversation adapter');
    const prepared = Promise.withResolvers<number>();
    const resume = Promise.withResolvers<undefined>();
    const channels: WorkspaceChannels = {
      ...chatWorkspaceChannels,
      guests: {
        ...real,
        prepareEdit: async (...args) => {
          const edit = await real.prepareEdit(...args);
          prepared.resolve(await pidOf(args[0]));
          await resume.promise;
          return edit;
        },
      },
    };
    const first = cloned.db.transaction().execute(async (db) => {
      await sql`set local lock_timeout = '4s'`.execute(db);
      return await updateGuestAccess(
        db,
        fixedClock(new Date()),
        await requireWorkspaceMembership(db, room.members['owner']?.userId ?? '', room.workspaceId),
        guest.userId,
        { channelIds: [room.channelId, firstChannel.id] },
        channels,
        true,
      );
    });
    let second: Promise<string> | undefined;
    try {
      const blocker = await Promise.race([
        prepared.promise,
        first.then(() => {
          throw new Error('First edit skipped preparation');
        }),
      ]);
      const connection = Promise.withResolvers<number>();
      second = cloned.db
        .transaction()
        .execute(async (db) => {
          await sql`set local lock_timeout = '4s'`.execute(db);
          connection.resolve(await pidOf(db));
          await updateGuestAccess(
            db,
            fixedClock(new Date()),
            await requireWorkspaceMembership(
              db,
              room.members['admin']?.userId ?? '',
              room.workspaceId,
            ),
            guest.userId,
            { channelIds: [room.channelId, secondChannel.id] },
            chatWorkspaceChannels,
            true,
          );
        })
        .then(() => 'changed', codeOf);
      const pid = await Promise.race([
        connection.promise,
        second.then(() => {
          throw new Error('Second edit had no connection');
        }),
      ]);
      expect(await waitsFor(pid, blocker, second)).toBe(true);
    } finally {
      resume.resolve(undefined);
      await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    }
    await first;
    expect(await second).toBe('VALIDATION_FAILED');
    const scope = await cloned.db
      .selectFrom('channel_members')
      .select('channel_id')
      .where('user_id', '=', guest.userId)
      .orderBy('channel_id')
      .execute();
    expect(scope.map((row) => row.channel_id)).toEqual([room.channelId, firstChannel.id].sort());
    expect(
      await cloned.db
        .selectFrom('audit_log')
        .select('id')
        .where('workspace_id', '=', room.workspaceId)
        .where('action', '=', 'member.guest_access_changed')
        .execute(),
    ).toHaveLength(1);
  }, 10_000);
});
