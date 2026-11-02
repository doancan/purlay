/**
 * A demotion and a send in an announcement channel at the same instant (D-243), each held open so the
 * locks decide, not the scheduler (`testing/gates.ts`).
 *
 * A send reads the sender's role under the workspace row's `KEY SHARE` lock, which a role change's
 * `FOR UPDATE` waits on and waits for (D-111 §2). So a demotion in flight makes the send wait and then
 * refuses it, and a send in flight makes the demotion wait and is kept — made while its sender was an
 * admin. `scripts/mutations.ts` removes the lock and requires the first to fail.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { BLOCKED_FOR_MS, holdOpen } from '../../testing/gates';
import { aRoom, type Room } from '../../testing/rooms';
import { changeRole } from '../workspaces/members';
import { sendMessage } from './messages';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** Resolves true if the promise settles within the window, false if it is still waiting. */
const settlesWithin = async (work: Promise<unknown>, ms: number): Promise<boolean> =>
  await Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    Bun.sleep(ms).then(() => false),
  ]);

/** An announcement channel: the owner, an admin and a member in it. */
const anAnnouncementRoom = async (db: Executor): Promise<Room> => {
  const room = await aRoom(db, ['owner', 'admin', 'bob']);
  await db
    .updateTable('workspace_members')
    .set({ role: 'admin' })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', room.members['admin']?.userId ?? '')
    .execute();
  await db
    .updateTable('channels')
    .set({ only_admins_post: true })
    .where('id', '=', room.channelId)
    .execute();
  return room;
};

const member = (room: Room, name: string): Room['members'][string] => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

/** The owner makes the admin a member, inside the transaction it is given. */
const demote = async (db: Executor, room: Room): Promise<void> => {
  const owner = await requireWorkspaceMembership(
    db,
    member(room, 'owner').userId,
    room.workspaceId,
  );
  await changeRole(db, clock, owner, member(room, 'admin').userId, 'member');
};

const rootsIn = async (db: Executor, room: Room): Promise<number> =>
  (
    await db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', room.channelId)
      .where('parent_id', 'is', null)
      .execute()
  ).length;

describe('integration: a demotion racing a send in an announcement channel', () => {
  test('a demotion in flight makes the send wait, and the send is then refused: nothing written', async () => {
    const db = cloned.db;
    const room = await anAnnouncementRoom(db);
    const owner = holdOpen(atomicallyOn(db));
    const demoting = owner.atomically(async (tx) => {
      await demote(tx, room);
    });
    await owner.holding;

    const sending = atomicallyOn(db)(
      async (tx) =>
        await sendMessage(tx, clock, member(room, 'admin').context, {
          id: nextId(),
          content: 'Son duyurum',
        }),
    );
    expect(await settlesWithin(sending, BLOCKED_FOR_MS)).toBe(false);
    owner.release();
    await demoting;
    const refusal = await sending.then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal instanceof AppError && refusal.body.code).toBe('ONLY_ADMINS_POST');
    expect(await rootsIn(db, room)).toBe(0);
  });

  test('a send in flight makes the demotion wait, and is kept; the next send is refused', async () => {
    const db = cloned.db;
    const room = await anAnnouncementRoom(db);
    const admin = holdOpen(atomicallyOn(db));
    const sending = admin.atomically(
      async (tx) =>
        await sendMessage(tx, clock, member(room, 'admin').context, {
          id: nextId(),
          content: 'Yönetici olarak yazdım',
        }),
    );
    await admin.holding;

    const demoting = atomicallyOn(db)(async (tx) => {
      await demote(tx, room);
    });
    expect(await settlesWithin(demoting, BLOCKED_FOR_MS)).toBe(false);
    admin.release();
    await Promise.all([sending, demoting]);
    expect(await rootsIn(db, room)).toBe(1);

    const next = await atomicallyOn(db)(
      async (tx) =>
        await sendMessage(tx, clock, member(room, 'admin').context, {
          id: nextId(),
          content: 'Bir tane daha',
        }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(next instanceof AppError && next.body.code).toBe('ONLY_ADMINS_POST');
    expect(await rootsIn(db, room)).toBe(1);
  });
});
