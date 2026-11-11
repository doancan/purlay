/** Expiry cleanup is durable, bounded and cannot destroy configured renewal scope. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  type Transaction,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { fixedClock } from '../../../platform/clock';
import { atomicallyOn } from '../../../platform/transactions';
import { NO_LOG, type EventBus } from '../../../platform/events';
import { updateGuestAccess } from '../../../modules/workspaces/guest-access';
import { convertGuest } from '../../../modules/workspaces/guest-conversion';
import type { WorkspaceChannels } from '../../../modules/workspaces/channels-port';
import { deliverScheduled } from '../scheduled/delivery';
import { deliverReminders } from '../reminders/delivery';
import { storeUpload } from '../../../modules/attachments/uploads';
import { createGuestInvitation } from '../../../modules/workspaces/guest-invitations';
import { acceptInvitation } from '../../../modules/workspaces/invitations';
import { aRoom } from '../../../testing/rooms';
import { aUserRow } from '../../../testing/users';
import { aMemoryStore } from '../../../testing/storage';
import { sendMessage } from '../messages/messages';
import { scheduleMessage } from '../scheduled/scheduled';
import { setReminder } from '../reminders/reminders';
import { chatWorkspaceChannels } from './workspace-channels';
import { sweepExpiredGuests } from './guest-expiry';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const setup = async (
  db: Transaction,
): Promise<{
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly guestId: string;
  readonly scheduledId: string;
  readonly fileId: string;
  readonly messageId: string;
}> => {
  const room = await aRoom(db, ['owner']);
  const ownerId = room.members['owner']?.userId ?? '';
  const owner = await requireWorkspaceMembership(db, ownerId, room.workspaceId);
  const guest = await aUserRow(db, 'expiry-cleanup');
  await db
    .updateTable('users')
    .set({ email_verified: true })
    .where('id', '=', guest.userId)
    .execute();
  const invitation = await createGuestInvitation(
    db,
    fixedClock(new Date()),
    owner,
    { email: guest.email, channelIds: [room.channelId], accessExpiresAt: null },
    chatWorkspaceChannels,
  );
  await acceptInvitation(
    db,
    fixedClock(new Date()),
    guest.userId,
    invitation.token,
    undefined,
    chatWorkspaceChannels,
    true,
  );
  const clock = fixedClock(new Date());
  const id = messageId(clock.now());
  const sender = room.members['owner'];
  if (sender === undefined) throw new Error('Missing owner');
  await sendMessage(db, clock, sender.context, { id, content: 'A message after admission' });
  const guestContext = await requireWorkspaceMembership(db, guest.userId, room.workspaceId);
  const { attachment } = await storeUpload(
    { atomically: atomicallyOn(db), storage: aMemoryStore(), log: NO_LOG },
    guestContext,
    { id: messageId(clock.now()), name: 'later.txt', bytes: new Uint8Array([3]) },
  );
  const scheduledId = messageId(clock.now());
  const future = new Date(clock.now().getTime() + 86_400_000).toISOString();
  await scheduleMessage(db, clock, guest.userId, room.channelId, scheduledId, {
    content: 'A future send',
    sendAt: future,
    attachmentIds: [attachment.id],
  });
  await setReminder(db, clock, guest.userId, id, future);
  await db
    .insertInto('notifications')
    .values({
      user_id: guest.userId,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      message_id: id,
      type: 'mention',
      created_at: clock.now(),
    })
    .execute();
  await db
    .updateTable('channel_members')
    .set({ unread_count: 5, unread_mention_count: 1 })
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', guest.userId)
    .execute();
  return {
    ownerId,
    workspaceId: room.workspaceId,
    channelId: room.channelId,
    guestId: guest.userId,
    scheduledId,
    fileId: attachment.id,
    messageId: id,
  };
};

const expire = async (db: Transaction, workspaceId: string, guestId: string): Promise<void> => {
  await db
    .updateTable('workspace_members')
    .set({
      guest_since: sql<Date>`statement_timestamp() - interval '2 hours'`,
      guest_expires_at: sql<Date>`statement_timestamp() - interval '1 hour'`,
    })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', guestId)
    .execute();
};

describe('integration: bounded expired guest cleanup', () => {
  test('expiry cancels pending attention and releases its file while retaining membership and channel choices', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      await expire(db, value.workspaceId, value.guestId);
      const result = await sweepExpiredGuests({ database: db });
      expect(result).toMatchObject({
        guests: 1,
        scheduled: 1,
        reservations: 1,
        reminders: 1,
        notifications: 1,
        channels: 1,
      });
      expect(
        await db
          .selectFrom('scheduled_messages')
          .select(['state', 'failure_code'])
          .where('id', '=', value.scheduledId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'failed', failure_code: 'WORKSPACE_NOT_FOUND' });
      expect(
        (
          await db
            .selectFrom('attachments')
            .select('claimed_at')
            .where('id', '=', value.fileId)
            .executeTakeFirstOrThrow()
        ).claimed_at,
      ).toBeNull();
      expect(
        await db
          .selectFrom('message_reminders')
          .select('id')
          .where('user_id', '=', value.guestId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('user_id', '=', value.guestId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await db
          .selectFrom('channel_members')
          .select(['channel_id', 'unread_count', 'unread_mention_count'])
          .where('user_id', '=', value.guestId)
          .execute(),
      ).toEqual([{ channel_id: value.channelId, unread_count: 0, unread_mention_count: 0 }]);
      expect(
        (
          await db
            .selectFrom('workspace_members')
            .select('access_kind')
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .executeTakeFirstOrThrow()
        ).access_kind,
      ).toBe('guest');
      expect((await sweepExpiredGuests({ database: db })).guests).toBe(0);
      // A row arriving after a completed sweep is durable work, without an in-memory processed set.
      await db
        .insertInto('message_reminders')
        .values({
          user_id: value.guestId,
          workspace_id: value.workspaceId,
          channel_id: value.channelId,
          message_id: value.messageId,
          remind_at: new Date(Date.now() + 60_000),
        })
        .execute();
      expect((await sweepExpiredGuests({ database: db })).reminders).toBe(1);
    });
  });

  test.each(['never', 'future', 'member'] as const)(
    'expiry preserves the complete pending state of %s access',
    async (kind) => {
      await withRollback(async (db) => {
        const value = await setup(db);
        if (kind === 'future')
          await db
            .updateTable('workspace_members')
            .set({ guest_expires_at: new Date(Date.now() + 86_400_000) })
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .execute();
        if (kind === 'member')
          await db
            .updateTable('workspace_members')
            .set({
              access_kind: 'member',
              guest_since: null,
              guest_expires_at: null,
              guest_modules: null,
            })
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .execute();
        expect((await sweepExpiredGuests({ database: db })).guests).toBe(0);
        expect(
          (
            await db
              .selectFrom('scheduled_messages')
              .select('state')
              .where('id', '=', value.scheduledId)
              .executeTakeFirstOrThrow()
          ).state,
        ).toBe('pending');
        expect(
          (
            await db
              .selectFrom('attachments')
              .select('claimed_at')
              .where('id', '=', value.fileId)
              .executeTakeFirstOrThrow()
          ).claimed_at,
        ).not.toBeNull();
        expect(
          await db
            .selectFrom('message_reminders')
            .select('id')
            .where('user_id', '=', value.guestId)
            .execute(),
        ).toHaveLength(1);
        expect(
          await db
            .selectFrom('notifications')
            .select('id')
            .where('user_id', '=', value.guestId)
            .execute(),
        ).toHaveLength(1);
      });
    },
  );

  const pauseFirstResult = (
    db: ClonedDatabase['db'],
  ): {
    readonly database: ClonedDatabase['db'];
    readonly entered: Promise<void>;
    readonly release: () => void;
  } => {
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let first = true;
    return {
      database: db.withPlugin({
        transformQuery: ({ node }): typeof node => node,
        transformResult: async ({ result }): Promise<typeof result> => {
          if (first) {
            first = false;
            entered.resolve(undefined);
            await resume.promise;
          }
          return result;
        },
      }),
      entered: entered.promise,
      release: (): void => {
        resume.resolve(undefined);
      },
    };
  };
  const setupCommitted = async (): ReturnType<typeof setup> =>
    await cloned.db.transaction().execute(async (tx) => {
      const value = await setup(tx);
      await expire(tx, value.workspaceId, value.guestId);
      return value;
    });

  // Returning rather than hanging is part of SKIP LOCKED's contract. Always release the competing
  // transaction before asserting, including when a fault deliberately turns a skip into a wait.
  const bounded = async <T>(work: Promise<T>): Promise<boolean> =>
    await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      Bun.sleep(1000).then(() => false),
    ]);

  test.each(['extend', 'convert'] as const)(
    'a captured expired candidate is rechecked after %s commits',
    async (action) => {
      const value = await setupCommitted();
      const held = pauseFirstResult(cloned.db);
      const sweep = sweepExpiredGuests({ database: held.database });
      await held.entered;
      try {
        await cloned.db.transaction().execute(async (tx) => {
          const owner = await requireWorkspaceMembership(tx, value.ownerId, value.workspaceId);
          if (action === 'extend')
            await updateGuestAccess(
              tx,
              fixedClock(new Date()),
              owner,
              value.guestId,
              { accessExpiresAt: null },
              chatWorkspaceChannels,
              true,
            );
          else
            await convertGuest(
              tx,
              fixedClock(new Date()),
              owner,
              value.guestId,
              { confirmFullAccess: true },
              chatWorkspaceChannels,
            );
        });
      } finally {
        held.release();
      }
      await sweep;
      expect(
        (
          await cloned.db
            .selectFrom('scheduled_messages')
            .select('state')
            .where('id', '=', value.scheduledId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('pending');
      expect(
        (
          await cloned.db
            .selectFrom('attachments')
            .select('claimed_at')
            .where('id', '=', value.fileId)
            .executeTakeFirstOrThrow()
        ).claimed_at,
      ).not.toBeNull();
      expect(
        await cloned.db
          .selectFrom('message_reminders')
          .select('id')
          .where('user_id', '=', value.guestId)
          .execute(),
      ).toHaveLength(1);
    },
  );

  test('cleanup skips a renewal holding the workspace mutex instead of deadlocking on its counter rows', async () => {
    const value = await setupCommitted();
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const guests = chatWorkspaceChannels.guests;
    if (guests === undefined) throw new Error('Missing guest adapter');
    const held: WorkspaceChannels = {
      ...chatWorkspaceChannels,
      guests: {
        ...guests,
        prepareEdit: async (...args): ReturnType<typeof guests.prepareEdit> => {
          const prepared = await guests.prepareEdit(...args);
          return {
            apply: async (...values): ReturnType<typeof prepared.apply> => {
              entered.resolve(undefined);
              await resume.promise;
              return await prepared.apply(...values);
            },
          };
        },
      },
    };
    const renewal = cloned.db
      .transaction()
      .execute(
        async (tx) =>
          await updateGuestAccess(
            tx,
            fixedClock(new Date()),
            await requireWorkspaceMembership(tx, value.ownerId, value.workspaceId),
            value.guestId,
            { accessExpiresAt: null },
            held,
            true,
          ),
      );
    await entered.promise;
    const sweep = sweepExpiredGuests({ database: cloned.db });
    const finished = await bounded(sweep);
    resume.resolve(undefined);
    await Promise.all([renewal, sweep]);
    expect(finished).toBe(true);
    expect(
      (
        await cloned.db
          .selectFrom('scheduled_messages')
          .select('state')
          .where('id', '=', value.scheduledId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('pending');
    expect((await sweepExpiredGuests({ database: cloned.db })).guests).toBe(0);
  });

  const noEvents: EventBus = {
    publish: async (): Promise<void> => {
      await Promise.resolve(undefined);
    },
    subscribe: (): boolean => false,
    unsubscribe: (): void => {
      /* no live subscriber */
    },
    forget: (): void => {
      /* no live subscriber */
    },
  };

  test.each(['scheduled', 'reminder'] as const)(
    'cleanup does not wait on an actual %s delivery that already claimed its child',
    async (kind) => {
      const value = await setupCommitted();
      await cloned.db
        .updateTable('scheduled_messages')
        .set({ send_at: new Date(Date.now() - 1000) })
        .where('id', '=', value.scheduledId)
        .execute();
      await cloned.db
        .updateTable('message_reminders')
        .set({ remind_at: new Date(Date.now() - 1000) })
        .where('user_id', '=', value.guestId)
        .execute();
      const held = pauseFirstResult(cloned.db);
      const dependencies = {
        database: held.database,
        clock: fixedClock(new Date()),
        bus: noEvents,
        log: NO_LOG,
      };
      const delivery =
        kind === 'scheduled' ? deliverScheduled(dependencies) : deliverReminders(dependencies);
      await held.entered;
      const sweep = sweepExpiredGuests({ database: cloned.db });
      const finished = await bounded(sweep);
      held.release();
      const [delivered] = await Promise.all([delivery, sweep]);
      expect(finished).toBe(true);
      expect(delivered).toBe(0);
      await sweepExpiredGuests({ database: cloned.db });
      expect(
        (
          await cloned.db
            .selectFrom('scheduled_messages')
            .select('state')
            .where('id', '=', value.scheduledId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('failed');
      expect(
        await cloned.db
          .selectFrom('message_reminders')
          .select('id')
          .where('user_id', '=', value.guestId)
          .execute(),
      ).toHaveLength(0);
      expect(
        (
          await cloned.db
            .selectFrom('attachments')
            .select('claimed_at')
            .where('id', '=', value.fileId)
            .executeTakeFirstOrThrow()
        ).claimed_at,
      ).toBeNull();
    },
  );

  test('a busy attachment remains a durable partial release and is reclaimed on the next sweep', async () => {
    const value = await setupCommitted();
    const locked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const holding = cloned.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', value.fileId)
        .forUpdate()
        .execute();
      locked.resolve(undefined);
      await release.promise;
    });
    await locked.promise;
    const sweep = sweepExpiredGuests({ database: cloned.db });
    const finished = await bounded(sweep);
    release.resolve(undefined);
    await holding;
    const result = await sweep;
    expect(finished).toBe(true);
    expect(result.deferred).toBeGreaterThan(0);
    expect(
      (
        await cloned.db
          .selectFrom('attachments')
          .select('claimed_at')
          .where('id', '=', value.fileId)
          .executeTakeFirstOrThrow()
      ).claimed_at,
    ).not.toBeNull();
    expect((await sweepExpiredGuests({ database: cloned.db })).reservations).toBe(1);
    expect(
      (
        await cloned.db
          .selectFrom('attachments')
          .select('claimed_at')
          .where('id', '=', value.fileId)
          .executeTakeFirstOrThrow()
      ).claimed_at,
    ).toBeNull();
  });

  test('a database failure rolls back the guest and a fresh worker connection resumes its durable rows', async () => {
    const value = await setupCommitted();
    await sql`create function guest_expiry_test_interrupt() returns trigger language plpgsql as $$
    begin raise exception 'expiry_test_interruption'; end; $$`.execute(cloned.db);
    await sql`create trigger guest_expiry_test_interrupt before delete on message_reminders
    for each row execute function guest_expiry_test_interrupt()`.execute(cloned.db);
    try {
      const failure = await sweepExpiredGuests({ database: cloned.db }).catch(
        (error: unknown): unknown => error,
      );
      expect(failure instanceof Error ? failure.message : null).toBe('expiry_test_interruption');
      expect(
        (
          await cloned.db
            .selectFrom('scheduled_messages')
            .select('state')
            .where('id', '=', value.scheduledId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('pending');
      expect(
        (
          await cloned.db
            .selectFrom('attachments')
            .select('claimed_at')
            .where('id', '=', value.fileId)
            .executeTakeFirstOrThrow()
        ).claimed_at,
      ).not.toBeNull();
    } finally {
      await sql`drop trigger guest_expiry_test_interrupt on message_reminders`.execute(cloned.db);
      await sql`drop function guest_expiry_test_interrupt()`.execute(cloned.db);
    }
    await cloned.withFreshPool(async (database) => {
      const before = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(cloned.db))
        .rows[0]?.pid;
      const after = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(database))
        .rows[0]?.pid;
      expect(before !== undefined && after !== undefined && before !== after).toBe(true);
      expect((await sweepExpiredGuests({ database })).scheduled).toBe(1);
    });
    expect(
      (
        await cloned.db
          .selectFrom('attachments')
          .select('claimed_at')
          .where('id', '=', value.fileId)
          .executeTakeFirstOrThrow()
      ).claimed_at,
    ).toBeNull();
  });

  test.each(['workspace', 'membership', 'reservation', 'counter', 'notification'] as const)(
    'a busy %s is deferred without waiting and remains eligible afterwards',
    async (kind) => {
      const value = await setupCommitted();
      const locked = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const holding = cloned.db.transaction().execute(async (tx) => {
        if (kind === 'workspace')
          await tx
            .selectFrom('workspaces')
            .select('id')
            .where('id', '=', value.workspaceId)
            .forNoKeyUpdate()
            .execute();
        else if (kind === 'membership')
          await tx
            .selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .forUpdate()
            .execute();
        else if (kind === 'reservation')
          await tx
            .selectFrom('scheduled_message_attachments')
            .select('attachment_id')
            .where('attachment_id', '=', value.fileId)
            .forUpdate()
            .execute();
        else if (kind === 'counter')
          await tx
            .selectFrom('channel_members')
            .select('channel_id')
            .where('user_id', '=', value.guestId)
            .where('channel_id', '=', value.channelId)
            .forUpdate()
            .execute();
        else
          await tx
            .selectFrom('notifications')
            .select('id')
            .where('user_id', '=', value.guestId)
            .forUpdate()
            .execute();
        locked.resolve(undefined);
        await release.promise;
      });
      await locked.promise;
      const sweep = sweepExpiredGuests({ database: cloned.db });
      const finished = await bounded(sweep);
      release.resolve(undefined);
      await holding;
      const result = await sweep;
      expect(finished).toBe(true);
      expect(result.deferred).toBeGreaterThan(0);
      if (kind === 'workspace' || kind === 'membership') {
        expect(
          (
            await cloned.db
              .selectFrom('scheduled_messages')
              .select('state')
              .where('id', '=', value.scheduledId)
              .executeTakeFirstOrThrow()
          ).state,
        ).toBe('pending');
      }
      await sweepExpiredGuests({ database: cloned.db });
      expect(
        (
          await cloned.db
            .selectFrom('attachments')
            .select('claimed_at')
            .where('id', '=', value.fileId)
            .executeTakeFirstOrThrow()
        ).claimed_at,
      ).toBeNull();
      expect((await sweepExpiredGuests({ database: cloned.db })).guests).toBe(0);
    },
  );

  test('the same person keeps pending work and counters in another workspace', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const other = await aRoom(db, ['elsewhere']);
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: other.workspaceId, user_id: value.guestId, role: 'member' })
        .execute();
      await db
        .insertInto('channel_members')
        .values({ channel_id: other.channelId, user_id: value.guestId, unread_count: 7 })
        .execute();
      const otherId = messageId(new Date());
      await scheduleMessage(db, fixedClock(new Date()), value.guestId, other.channelId, otherId, {
        content: 'Another workspace',
        sendAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await expire(db, value.workspaceId, value.guestId);
      await sweepExpiredGuests({ database: db });
      expect(
        (
          await db
            .selectFrom('scheduled_messages')
            .select('state')
            .where('id', '=', otherId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('pending');
      expect(
        (
          await db
            .selectFrom('channel_members')
            .select('unread_count')
            .where('channel_id', '=', other.channelId)
            .where('user_id', '=', value.guestId)
            .executeTakeFirstOrThrow()
        ).unread_count,
      ).toBe(7);
    });
  });

  test('removing a stale reservation preserves a file already used by an actual message', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      await db
        .insertInto('message_attachments')
        .values({
          workspace_id: value.workspaceId,
          channel_id: value.channelId,
          message_id: value.messageId,
          attachment_id: value.fileId,
        })
        .execute();
      await expire(db, value.workspaceId, value.guestId);
      expect((await sweepExpiredGuests({ database: db })).reservations).toBe(1);
      expect(
        (
          await db
            .selectFrom('attachments')
            .select('claimed_at')
            .where('id', '=', value.fileId)
            .executeTakeFirstOrThrow()
        ).claimed_at,
      ).not.toBeNull();
      expect(
        await db
          .selectFrom('message_attachments')
          .select('attachment_id')
          .where('attachment_id', '=', value.fileId)
          .execute(),
      ).toHaveLength(1);
    });
  });

  test('one large pending backlog respects each row cap and drains on subsequent runs', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const messages = Array.from({ length: 500 }, () => ({
        id: messageId(new Date()),
        workspace_id: value.workspaceId,
        channel_id: value.channelId,
        sender_id: value.ownerId,
        content: 'Retention boundary',
      }));
      await db.insertInto('messages').values(messages).execute();
      await db
        .insertInto('notifications')
        .values(
          messages.map((row) => ({
            user_id: value.guestId,
            workspace_id: value.workspaceId,
            channel_id: value.channelId,
            message_id: row.id,
            type: 'mention' as const,
          })),
        )
        .execute();
      await db
        .insertInto('message_reminders')
        .values(
          messages.slice(0, 100).map((row) => ({
            user_id: value.guestId,
            workspace_id: value.workspaceId,
            channel_id: value.channelId,
            message_id: row.id,
            remind_at: new Date(Date.now() + 86_400_000),
          })),
        )
        .execute();
      await db
        .insertInto('scheduled_messages')
        .values(
          messages.slice(0, 100).map(() => ({
            id: messageId(new Date()),
            user_id: value.guestId,
            workspace_id: value.workspaceId,
            channel_id: value.channelId,
            content: 'Restored pending message',
            send_at: new Date(Date.now() + 86_400_000),
          })),
        )
        .execute();
      const extra = await db
        .insertInto('channels')
        .values(
          Array.from({ length: 20 }, (_, i) => ({
            workspace_id: value.workspaceId,
            name: 'restored-' + String(i),
            type: 'public' as const,
          })),
        )
        .returning('id')
        .execute();
      await db
        .insertInto('channel_members')
        .values(
          extra.map((row) => ({ channel_id: row.id, user_id: value.guestId, unread_count: 1 })),
        )
        .execute();
      await expire(db, value.workspaceId, value.guestId);
      expect(await sweepExpiredGuests({ database: db })).toMatchObject({
        guests: 1,
        scheduled: 100,
        reminders: 100,
        notifications: 500,
        channels: 20,
        deferred: 1,
      });
      expect(await sweepExpiredGuests({ database: db })).toMatchObject({
        guests: 1,
        scheduled: 1,
        reminders: 1,
        notifications: 1,
        channels: 1,
        deferred: 0,
      });
      expect((await sweepExpiredGuests({ database: db })).guests).toBe(0);
    });
  }, 30_000);

  test('one run cleans at most100 guests and the next run finds the rest without a cursor', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner']);
      const owner = room.members['owner'];
      if (owner === undefined) throw new Error('Missing owner');
      const id = messageId(new Date());
      await sendMessage(db, fixedClock(new Date()), owner.context, {
        id,
        content: 'Pending attention',
      });
      const userIds: string[] = [];
      for (let i = 0; i < 101; i += 1) userIds.push((await aUserRow(db, 'expiry-volume')).userId);
      await db
        .insertInto('workspace_members')
        .values(
          userIds.map((userId) => ({
            workspace_id: room.workspaceId,
            user_id: userId,
            role: 'member' as const,
            access_kind: 'guest' as const,
            guest_since: sql<Date>`statement_timestamp() - interval '2 hours'`,
            guest_expires_at: sql<Date>`statement_timestamp() - interval '1 hour'`,
            guest_modules: ['chat'],
          })),
        )
        .execute();
      await db
        .insertInto('notifications')
        .values(
          userIds.map((userId) => ({
            workspace_id: room.workspaceId,
            user_id: userId,
            channel_id: room.channelId,
            message_id: id,
            type: 'mention' as const,
          })),
        )
        .execute();
      expect(await sweepExpiredGuests({ database: db })).toMatchObject({
        guests: 100,
        notifications: 100,
      });
      expect(await sweepExpiredGuests({ database: db })).toMatchObject({
        guests: 1,
        notifications: 1,
      });
      expect((await sweepExpiredGuests({ database: db })).guests).toBe(0);
    });
  }, 30_000);
});
