/**
 * A deletion taken back at the moment its grace period ends (D-242), on a cloned database with real
 * connections — inside the harness's one transaction nothing races (D-46, D-77). Each side is held open
 * until the database says the other is waiting on the workspace's row, so the outcome is not left to
 * scheduling:
 *
 * - **taken back first**: the job, waiting, finds nothing to claim — the workspace is back, all of it;
 * - **claimed first**: the owner, waiting, is told it is too late (`409 WORKSPACE_DELETION_STARTED`), and the
 *   erasure goes on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { WORKSPACE_DELETION_GRACE_DAYS, messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { requireDeletionMembership } from '../../platform/tenancy';
import { aRecordingLogger, NOW, testDependencies } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
import { askToDelete, takeBackDeletion } from '../../modules/workspaces/deletion';
import { purgeWorkspaces } from '../../modules/workspaces/deletion-purge';
import { createApp } from './app';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const clock = fixedClock(NOW);
const DUE = new Date(NOW.getTime() + WORKSPACE_DELETION_GRACE_DAYS * DAY_MS);

const owner = (room: Room): string => {
  const ada = room.members['ada'];
  if (ada === undefined) throw new Error('no ada');
  return ada.userId;
};

/** A workspace with a message in it, its deletion asked for at `NOW`. */
const aDoomedRoom = async (): Promise<Room> => {
  const room = await aRoom(cloned.db, ['ada', 'bob']);
  await cloned.db
    .insertInto('messages')
    .values({
      id: messageId(NOW),
      channel_id: room.channelId,
      workspace_id: room.workspaceId,
      sender_id: owner(room),
      content: 'kept or not',
      created_at: NOW,
    })
    .execute();
  const context = await requireDeletionMembership(cloned.db, owner(room), room.workspaceId);
  await cloned.db.transaction().execute(async (transaction) => {
    await askToDelete(transaction, clock, context, 'Room');
  });
  return room;
};

/** Resolves once some connection of this database waits on a lock. */
const somebodyWaits = async (): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await sql<{ waiting: string }>`
      select count(*)::text as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `.execute(cloned.db);
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('nobody came to wait on the workspace’s row');
    await Bun.sleep(10);
  }
};

const messagesOf = async (room: Room): Promise<number> =>
  (
    await cloned.db
      .selectFrom('messages')
      .select('id')
      .where('workspace_id', '=', room.workspaceId)
      .execute()
  ).length;

const purge = (): ReturnType<typeof purgeWorkspaces> =>
  purgeWorkspaces({
    database: cloned.db,
    clock: fixedClock(DUE),
    log: aRecordingLogger().log,
    storage: aMemoryStore(),
  });

describe('integration: a deletion taken back as its grace period ends', () => {
  test('taken back first: the job waits, then finds nothing to claim, and the workspace is whole', async () => {
    const room = await aDoomedRoom();
    const context = await requireDeletionMembership(cloned.db, owner(room), room.workspaceId);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelling = cloned.db.transaction().execute(async (transaction) => {
      await takeBackDeletion(transaction, clock, context);
      await held;
    });
    // The job's claim waits on the row the cancellation holds.
    const running = purge();
    await somebodyWaits();
    release();
    await cancelling;
    expect(await running).toMatchObject({ workspaces: 0 });
    const row = await cloned.db
      .selectFrom('workspaces')
      .select(['deleted_at', 'purge_started_at', 'purged_at'])
      .where('id', '=', room.workspaceId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ deleted_at: null, purge_started_at: null, purged_at: null });
    expect(await messagesOf(room)).toBe(1);
  });

  test('claimed first: the owner waits, then is told it is too late, and the erasure goes on', async () => {
    const room = await aDoomedRoom();
    const { token } = await aSession(cloned.db, clock, owner(room), 30);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The claim, as the job makes it, held open.
    const claiming = cloned.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('workspaces')
        .set({ purge_started_at: DUE })
        .where('id', '=', room.workspaceId)
        .where('purge_started_at', 'is', null)
        .execute();
      await held;
    });
    const cancelling = createApp(testDependencies({ database: cloned.db, clock })).handle(
      new Request(`https://purlay.test/api/workspaces/${room.workspaceId}/deletion`, {
        method: 'DELETE',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    await somebodyWaits();
    release();
    await claiming;
    const answer = await cancelling;
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ error: { code: 'WORKSPACE_DELETION_STARTED' } });
    expect(await purge()).toMatchObject({ workspaces: 1, messages: 1 });
    expect(await messagesOf(room)).toBe(0);
  });
});
