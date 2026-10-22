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
import { acceptInvitation, createInvitation } from '../workspaces/invitations';
import { changeRole, removeMember } from '../workspaces/members';
import { auditTrail, recordAudit } from './audit';
import { aSession } from '../../testing/signed-in';
import { withinRequest } from '../../platform/logging';

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
      const newcomer = (
        await db
          .insertInto('users')
          .values({ email: 'new@example.test', username: 'newcomer69', display_name: 'New' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // Moments apart: the trail's order is its ids', which are their instants'.
      const { invitation, token } = await createInvitation(
        db,
        fixedClock(new Date(NOW.getTime() + 500)),
        alice,
      );
      const later = fixedClock(new Date(NOW.getTime() + 1_000));
      await acceptInvitation(db, later, newcomer, token);
      await acceptInvitation(db, later, newcomer, token);
      expect(
        (await trail(db, room)).map((row) => [row.action, row.actor_user_id, row.target_id]),
      ).toEqual([
        ['channel.created', idOf(room, 'alice'), channel.id],
        ['invitation.created', idOf(room, 'alice'), invitation.id],
        ['member.joined', newcomer, newcomer],
      ]);
    });
  });
});

describe('integration: reading the trail', () => {
  test('is an owner’s and an admin’s, newest first, a page at a time; a member is refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const alice = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      for (let step = 0; step < 3; step += 1) {
        const at = fixedClock(new Date(NOW.getTime() + step * 1_000));
        await changeRole(db, at, alice, idOf(room, 'bob'), step % 2 === 0 ? 'admin' : 'member');
      }
      const other = await aRoom(db, ['dave', 'erin']);
      const dave = await requireWorkspaceMembership(db, idOf(other, 'dave'), other.workspaceId);
      await changeRole(db, clock, dave, idOf(other, 'erin'), 'admin');

      const first = await auditTrail(db, alice, { limit: 2 });
      expect(first.data.map((entry) => entry.metadata)).toEqual([
        { from: 'member', to: 'admin' },
        { from: 'admin', to: 'member' },
      ]);
      expect(first.data[0]).toMatchObject({
        actor: { id: idOf(room, 'alice') },
        action: 'member.role_changed',
        targetType: 'user',
        targetId: idOf(room, 'bob'),
        createdAt: new Date(NOW.getTime() + 2_000).toISOString(),
      });
      const rest = await auditTrail(db, alice, { before: first.nextCursor ?? '', limit: 2 });
      expect(rest.data.map((entry) => entry.metadata)).toEqual([{ from: 'member', to: 'admin' }]);
      expect(rest.nextCursor).toBeNull();

      // bob is an admin again after the last step: he reads it; carol, a member, does not.
      const bob = await requireWorkspaceMembership(db, idOf(room, 'bob'), room.workspaceId);
      expect((await auditTrail(db, bob, {})).data).toHaveLength(3);
      const carol = await requireWorkspaceMembership(db, idOf(room, 'carol'), room.workspaceId);
      let refused = '';
      await auditTrail(db, carol, {}).catch((error: unknown) => {
        if (error instanceof AppError) refused = error.body.code;
      });
      expect(refused).toBe('FORBIDDEN');
    });
  });
});

describe('integration: a row with no request behind it', () => {
  test('names no session: a job, or a script, acted as nobody signed in (D-116)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['solo']);
      await recordAudit(db, fixedClock(NOW), {
        workspaceId: room.workspaceId,
        actorUserId: null,
        action: 'member.removed',
        targetType: 'user',
        targetId: idOf(room, 'solo'),
      });
      const [row] = await db
        .selectFrom('audit_log')
        .select('session_id')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(row?.session_id).toBeNull();
    });
  });

  test('a row a request wrote names its session, and loses it when the session is swept', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['acted']);
      const { sessionId } = await aSession(db, fixedClock(NOW), idOf(room, 'acted'), 1);
      await withinRequest({ requestId: 'r', startedAt: 0, sessionId }, async () => {
        await recordAudit(db, fixedClock(NOW), {
          workspaceId: room.workspaceId,
          actorUserId: idOf(room, 'acted'),
          action: 'member.removed',
          targetType: 'user',
          targetId: idOf(room, 'acted'),
        });
      });
      const sessionOf = async (): Promise<string | null | undefined> =>
        (
          await db
            .selectFrom('audit_log')
            .select('session_id')
            .where('workspace_id', '=', room.workspaceId)
            .executeTakeFirst()
        )?.session_id;
      expect(await sessionOf()).toBe(sessionId);
      // The sweep deletes a dead session (D-87); the trail keeps the row and lets the link go.
      await db.deleteFrom('sessions').where('id', '=', sessionId).execute();
      expect(await sessionOf()).toBeNull();
    });
  });
});
