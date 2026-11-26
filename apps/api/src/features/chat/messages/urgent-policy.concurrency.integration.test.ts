import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { setUrgentMessages } from '../../../modules/workspaces/urgent-messages';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import { holdOpen } from '../../../testing/gates';
import { aRoom } from '../../../testing/rooms';
import { sendMessage } from './messages';

const now = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(now);
let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

/** Wait for a real database lock or for the competing operation to finish first. */
const waitsForLock = async (work: Promise<unknown>): Promise<boolean> => {
  const status = { finished: false };
  const done = (): void => {
    status.finished = true;
  };
  void work.then(done, done);
  const deadline = Date.now() + 5_000;
  while (!status.finished) {
    const { rows } = await sql<{ waiting: boolean }>`
      select exists (select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock') as waiting
    `.execute(cloned.db);
    if (rows[0]?.waiting === true) return true;
    if (Date.now() > deadline) throw new Error('The competing transaction never took a turn');
    await Bun.sleep(10);
  }
  return false;
};

describe('integration: urgent sends take their turn with the workspace setting', () => {
  test.each(['setting', 'send'] as const)(
    '%s first determines which policy a new urgent send sees',
    async (first) => {
      const db = cloned.db;
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('no alice');
      const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
      const id = messageId(now);
      const send: Parameters<ReturnType<typeof atomicallyOn>>[0] = async (tx) =>
        await sendMessage(tx, clock, alice.context, {
          id,
          content: 'please look',
          priority: 'urgent',
        });
      const setting: Parameters<ReturnType<typeof atomicallyOn>>[0] = async (tx) =>
        await setUrgentMessages(tx, clock, context, false);
      const atomically = atomicallyOn(db);
      const held = holdOpen(atomically);
      const earlier = (
        first === 'setting' ? held.atomically(setting) : held.atomically(send)
      ).catch((error: unknown) => error);
      let later: Promise<unknown> | undefined;
      try {
        expect(await Promise.race([held.holding, earlier])).toBeUndefined();
        later = (first === 'setting' ? atomically(send) : atomically(setting)).catch(
          (error: unknown) => error,
        );
        expect(await waitsForLock(later)).toBe(true);
      } finally {
        held.release();
      }
      expect(await earlier).not.toBeInstanceOf(Error);
      const result = await later;
      const message = await db
        .selectFrom('messages')
        .select('priority')
        .where('id', '=', id)
        .executeTakeFirst();
      if (first === 'setting') {
        expect(result).toMatchObject({
          body: {
            code: 'VALIDATION_FAILED',
            details: { fields: { priority: 'urgent messages are disabled in this workspace' } },
          },
        });
        expect(message).toBeUndefined();
      } else {
        expect(result).not.toBeInstanceOf(Error);
        expect(message?.priority).toBe('urgent');
      }
    },
  );

  test('an admin demoted while waiting cannot change the setting', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const bob = room.members['bob'];
    if (bob === undefined) throw new Error('no bob');
    await db
      .updateTable('workspace_members')
      .set({ role: 'admin' })
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', bob.userId)
      .execute();
    const context = await requireWorkspaceMembership(db, bob.userId, room.workspaceId);
    const atomically = atomicallyOn(db);
    const held = holdOpen(atomically);
    const demoted = held
      .atomically(async (tx) => {
        await tx
          .selectFrom('workspaces')
          .select('id')
          .where('id', '=', room.workspaceId)
          .forUpdate()
          .execute();
        await tx
          .updateTable('workspace_members')
          .set({ role: 'member' })
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', bob.userId)
          .execute();
      })
      .catch((error: unknown) => error);
    let setting: Promise<unknown> | undefined;
    try {
      expect(await Promise.race([held.holding, demoted])).toBeUndefined();
      setting = atomically(async (tx) => await setUrgentMessages(tx, clock, context, false)).catch(
        (error: unknown) => error,
      );
      expect(await waitsForLock(setting)).toBe(true);
    } finally {
      held.release();
    }
    expect(await demoted).toBeUndefined();
    expect(await setting).toMatchObject({ body: { code: 'FORBIDDEN' } });
    expect(
      await db
        .selectFrom('workspaces')
        .select('urgent_messages_enabled')
        .where('id', '=', room.workspaceId)
        .executeTakeFirst(),
    ).toEqual({ urgent_messages_enabled: true });
  });
});
