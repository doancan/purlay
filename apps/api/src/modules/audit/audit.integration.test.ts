/**
 * The audit trail (D-26, I-9, #69): every administrative action writes exactly one row, in the
 * transaction that does it — so a refused or rolled-back action writes none — and the row says who
 * did what to whom, never anything that was said.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, isTransaction, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, type Room } from '../../testing/rooms';
import { createChannel } from '../channels/channels';
import { joinOpenWorkspace } from '../workspaces/open-join';
import { changeRole, removeMember } from '../workspaces/members';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const idOf = (room: Room, name: string): string => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found.userId;
};

interface TrailRow {
  readonly actor_user_id: string | null;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly metadata: unknown;
  readonly created_at: Date;
}

const trail = async (db: Executor, room: Room): Promise<TrailRow[]> =>
  await db
    .selectFrom('audit_log')
    .select(['actor_user_id', 'action', 'target_type', 'target_id', 'metadata', 'created_at'])
    .where('workspace_id', '=', room.workspaceId)
    .orderBy('id')
    .execute();

describe('integration: the audit trail', () => {
  test('a role change: who, whom, from and to — once; the same role again records nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      await changeRole(db, clock, alice, idOf(room, 'bob'), 'admin');
      await changeRole(db, clock, alice, idOf(room, 'bob'), 'admin');
      expect(await trail(db, room)).toEqual([
        {
          actor_user_id: idOf(room, 'alice'),
          action: 'member.role_changed',
          target_type: 'user',
          target_id: idOf(room, 'bob'),
          metadata: { from: 'member', to: 'admin' },
          created_at: NOW,
        },
      ]);
    });
  });

  test('a removal is recorded; one refused records nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      await removeMember(db, clock, alice, idOf(room, 'alice')).catch((error: unknown) => {
        if (!(error instanceof AppError)) throw error;
      });
      expect(await trail(db, room)).toEqual([]);
      await removeMember(db, clock, alice, idOf(room, 'bob'));
      expect((await trail(db, room)).map((row) => [row.action, row.target_id])).toEqual([
        ['member.removed', idOf(room, 'bob')],
      ]);
    });
  });

  test('a channel created, and somebody joining by the open door, are recorded', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      // Inside the test's own transaction, as a route runs it inside its own.
      if (!isTransaction(db)) throw new Error('withRollback gives a transaction');
      const channel = await createChannel(db, clock, alice, { name: 'audited', type: 'public' });
      const { slug } = await db
        .selectFrom('workspaces')
        .select('slug')
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow();
      const newcomer = (
        await db
          .insertInto('users')
          .values({ email: 'new@example.test', username: 'newcomer69', display_name: 'New' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // A moment later: the trail's order is its ids', which are their instants'.
      const later = fixedClock(new Date(NOW.getTime() + 1_000));
      await joinOpenWorkspace(db, later, slug, newcomer);
      await joinOpenWorkspace(db, later, slug, newcomer);
      expect(
        (await trail(db, room)).map((row) => [row.action, row.actor_user_id, row.target_id]),
      ).toEqual([
        ['channel.created', idOf(room, 'alice'), channel.id],
        ['member.joined', newcomer, newcomer],
      ]);
    });
  });
});
