/**
 * A write by a session that ends commits before the end or not at all.
 *
 * A socket authenticates once, at the upgrade, and cached the identity: a
 * sign-out that raced a send let one write commit *after* `revoked_at` (found by
 * attack; 0 frames reached the closed socket). The send now takes a share lock on
 * the session row in the transaction that writes, so a revocation — which updates
 * that row — cannot commit between the check and the write.
 *
 * On a cloned database, because commit order is the behaviour under test and the
 * harness's single rolled-back transaction has no order to speak of (D-46).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { atomicallyOn } from '../../platform/transactions';
import type { EventBus } from '../../platform/events';
import { requireChannelById } from '../../platform/channels';
import { NOW } from '../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { issueSession, requireLiveSession, revokeSession } from '../auth/sessions';
import { send } from './messages';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

const clock = fixedClock(NOW);
/** Nobody is listening; what is under test is the write. */
const aSilentBus: EventBus = {
  publish: async () => {
    await Promise.resolve();
  },
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};
const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const aRoom = async (): Promise<{
  token: string;
  sessionId: string;
  channelId: string;
  userId: string;
}> => {
  const user = await aUserRow(cloned.db, 'sess');
  const { token } = await issueSession(cloned.db, clock, user.userId, 30);
  const session = await cloned.db
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', user.userId)
    .executeTakeFirstOrThrow();
  const workspace = await cloned.db
    .insertInto('workspaces')
    .values({ name: 'W', slug: aUniqueSlug('sess') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await cloned.db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: user.userId, role: 'owner' })
    .execute();
  const channel = await cloned.db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { token, sessionId: session.id, channelId: channel.id, userId: user.userId };
};

const sending = async (room: Awaited<ReturnType<typeof aRoom>>): Promise<unknown> => {
  const context = await requireChannelById(cloned.db, room.userId, room.channelId);
  return await send(
    {
      atomically: atomicallyOn(cloned.db),
      clock,
      bus: aSilentBus,
    },
    context,
    { id: messageId(NOW), content: 'hello' },
    room.sessionId,
  ).then(
    () => 'sent',
    (error: unknown) => error,
  );
};

const written = async (channelId: string): Promise<number> =>
  (
    await cloned.db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', channelId)
      .execute()
  ).length;

describe('integration: a send by a session that is being revoked', () => {
  test('is refused when the revocation commits first, and writes nothing', async () => {
    const room = await aRoom();
    let outcome: Promise<unknown> | undefined;

    // The sign-out holds the session row, uncommitted, while the send starts.
    await cloned.db.transaction().execute(async (transaction) => {
      await revokeSession(transaction, clock, room.token);
      outcome = sending(room);
      await pause(150);
    });

    const result = await outcome;
    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).body.code).toBe('UNAUTHENTICATED');
    expect(await written(room.channelId)).toBe(0);
  });

  /** The other order: the write is in flight, so the revocation waits for its commit. */
  test('makes the revocation wait for a write already holding the session', async () => {
    const room = await aRoom();
    let settled = false;
    let revocation: Promise<unknown> | undefined;

    await cloned.db.transaction().execute(async (transaction) => {
      await requireLiveSession(transaction, clock, room.sessionId);
      revocation = revokeSession(cloned.db, clock, room.token).then(() => {
        settled = true;
      });
      await pause(150);
      expect(settled).toBe(false);
    });

    await revocation;
    expect(settled).toBe(true);
    const row = await cloned.db
      .selectFrom('sessions')
      .select('revoked_at')
      .where('id', '=', room.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
  });

  test('control: with no revocation in flight the same send commits', async () => {
    const room = await aRoom();
    expect(await sending(room)).toBe('sent');
    expect(await written(room.channelId)).toBe(1);
  });

  test('a session that has already ended or expired is refused', async () => {
    const room = await aRoom();
    await revokeSession(cloned.db, clock, room.token);
    expect(((await sending(room)) as AppError).body.code).toBe('UNAUTHENTICATED');

    const expired = await aRoom();
    await cloned.db
      .updateTable('sessions')
      .set({ expires_at: new Date(NOW.getTime() - 1000) })
      .where('id', '=', expired.sessionId)
      .execute();
    expect(((await sending(expired)) as AppError).body.code).toBe('UNAUTHENTICATED');
  });
});
