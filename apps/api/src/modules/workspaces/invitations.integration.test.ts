/**
 * Invitation links (D-115, #50): who may make and revoke one, what joining by one does and does not
 * do, and when a link stops opening — at its expiry to the millisecond, on revocation, with its
 * workspace deleted — always as the one refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  type ClonedDatabase,
  type Executor,
  type Transaction,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { INVITATION_TTL_DAYS } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aMovableClock } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import {
  acceptInvitation as acceptIn,
  type AcceptedInvitation,
  createInvitation as createIn,
  listInvitations,
  previewInvitation,
  revokeInvitation as revokeIn,
} from './invitations';
import { changeRole, removeMember } from './members';
import type { Clock } from '../../platform/clock';
import type { CreatedInvitation } from '@purlay/types';
import { requireChannelById } from '../../platform/channels';

/** The writing services take a transaction (#232); inside the harness's, one joins it. */
const createInvitation = async (
  db: Executor,
  clock: Clock,
  context: WorkspaceContext,
): Promise<CreatedInvitation> =>
  await atomicallyOn(db)(async (transaction) => await createIn(transaction, clock, context));
const revokeInvitation = async (
  db: Executor,
  clock: Clock,
  context: WorkspaceContext,
  id: string,
): Promise<void> => {
  await atomicallyOn(db)(async (transaction) => {
    await revokeIn(transaction, clock, context, id);
  });
};
const acceptInvitation = async (
  db: Executor,
  clock: Clock,
  userId: string,
  token: string,
): Promise<AcceptedInvitation> =>
  await atomicallyOn(db)(async (transaction) => await acceptIn(transaction, clock, userId, token));

const TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const as = async (db: Executor, room: Room, name: string): Promise<WorkspaceContext> => {
  const person = room.members[name];
  if (person === undefined) throw new Error(`no ${name}`);
  return await requireWorkspaceMembership(db, person.userId, room.workspaceId);
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  const error = await work.then(
    () => null,
    (failure: unknown) => failure,
  );
  if (!(error instanceof AppError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error.body.code;
};

const auditOf = async (
  db: Executor,
  workspaceId: string,
): Promise<{ action: string; metadata: unknown }[]> =>
  await db
    .selectFrom('audit_log')
    .select(['action', 'metadata'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('id', 'asc')
    .execute();

describe('integration: making and revoking a link', () => {
  test('an owner or an admin makes one; its token is in the answer and only its digest is kept', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner', 'in-admin']);
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', room.members['in-admin']?.userId ?? '')
        .execute();

      const made = await createInvitation(db, clock, await as(db, room, 'in-owner'));
      expect(made.token).toMatch(/^[0-9a-f]{64}$/);
      expect(made.invitation.createdBy?.username).toBe(room.members['in-owner']?.username);
      expect(Date.parse(made.invitation.expiresAt) - clock.now().getTime()).toBe(TTL_MS);
      await createInvitation(db, clock, await as(db, room, 'in-admin'));

      const stored = await db
        .selectFrom('workspace_invitations')
        .select('token_hash')
        .where('id', '=', made.invitation.id)
        .executeTakeFirstOrThrow();
      // The digest, never the token: a copy of the table opens nothing.
      expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.token_hash).not.toBe(made.token);
      expect((await auditOf(db, room.workspaceId)).map((row) => row.action)).toEqual([
        'invitation.created',
        'invitation.created',
      ]);
    });
  });

  test('a member may not make, list or revoke one', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner2', 'in-member2']);
      const made = await createInvitation(db, clock, await as(db, room, 'in-owner2'));
      const member = await as(db, room, 'in-member2');
      expect(await refusal(createInvitation(db, clock, member))).toBe('FORBIDDEN');
      expect(await refusal(listInvitations(db, clock, member, {}))).toBe('FORBIDDEN');
      expect(await refusal(revokeInvitation(db, clock, member, made.invitation.id))).toBe(
        'FORBIDDEN',
      );
    });
  });

  test('a workspace’s list holds its own links and no other workspace’s', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner18']);
      const other = await aRoom(db, ['in-owner18b']);
      const owner = await as(db, room, 'in-owner18');
      const ours = await createInvitation(db, clock, owner);
      clock.advance(1);
      await createInvitation(db, clock, await as(db, other, 'in-owner18b'));

      expect((await listInvitations(db, clock, owner, {})).data.map((i) => i.id)).toEqual([
        ours.invitation.id,
      ]);
    });
  });

  test('the list holds what still opens, newest first, a page at a time', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner3']);
      const owner = await as(db, room, 'in-owner3');
      const first = await createInvitation(db, clock, owner);
      clock.advance(1);
      const revoked = await createInvitation(db, clock, owner);
      clock.advance(1);
      const third = await createInvitation(db, clock, owner);
      await revokeInvitation(db, clock, owner, revoked.invitation.id);

      const page = await listInvitations(db, clock, owner, { limit: 1 });
      expect(page.data.map((i) => i.id)).toEqual([third.invitation.id]);
      expect(page.nextCursor).toBe(third.invitation.id);
      const rest = await listInvitations(db, clock, owner, { before: page.nextCursor ?? '' });
      expect(rest).toEqual({ data: [first.invitation], nextCursor: null });

      clock.advance(TTL_MS);
      expect((await listInvitations(db, clock, owner, {})).data).toEqual([]);
    });
  });

  test('revoking is idempotent and recorded once; a link of another workspace is not found', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner4']);
      const other = await aRoom(db, ['in-owner4b']);
      const owner = await as(db, room, 'in-owner4');
      const made = await createInvitation(db, clock, owner);
      const theirs = await createInvitation(db, clock, await as(db, other, 'in-owner4b'));

      await revokeInvitation(db, clock, owner, made.invitation.id);
      await revokeInvitation(db, clock, owner, made.invitation.id);
      // Written within one millisecond, so their ids do not order them: counted by kind.
      expect((await auditOf(db, room.workspaceId)).map((row) => row.action).sort()).toEqual([
        'invitation.created',
        'invitation.revoked',
      ]);
      expect(await refusal(revokeInvitation(db, clock, owner, theirs.invitation.id))).toBe(
        'INVITATION_NOT_FOUND',
      );
    });
  });
});

describe('integration: joining by a link', () => {
  test('somebody already in another workspace is answered with the one they joined', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const theirs = await aRoom(db, ['in-elsewhere16']);
      const room = await aRoom(db, ['in-owner16']);
      const made = await createInvitation(db, clock, await as(db, room, 'in-owner16'));
      const already = theirs.members['in-elsewhere16']?.userId ?? '';
      // Joined long before, so a list of their memberships would put that one first.
      await db
        .updateTable('workspace_members')
        .set({ joined_at: new Date('2020-01-01T00:00:00.000Z') })
        .where('workspace_id', '=', theirs.workspaceId)
        .where('user_id', '=', already)
        .execute();

      const { membership: joined } = await acceptInvitation(db, clock, already, made.token);
      expect(joined.workspace.id).toBe(room.workspaceId);
      expect(joined.role).toBe('member');
    });
  });

  test('a removal from another workspace does not shut this one’s link', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const other = await aRoom(db, ['in-otherowner17', 'in-person17']);
      const room = await aRoom(db, ['in-owner17']);
      const made = await createInvitation(db, clock, await as(db, room, 'in-owner17'));
      const person = other.members['in-person17']?.userId ?? '';
      clock.advance(1_000);
      await atomicallyOn(db)(async (transaction) => {
        await removeMember(transaction, clock, await as(db, other, 'in-otherowner17'), person);
      });

      expect((await acceptInvitation(db, clock, person, made.token)).membership.workspace.id).toBe(
        room.workspaceId,
      );
    });
  });

  test('a stranger joins as a member, told so as /api/me would, and it is recorded with the link', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner5']);
      const made = await createInvitation(db, clock, await as(db, room, 'in-owner5'));
      const stranger = await aUserRow(db, 'in-stranger5');

      expect(await previewInvitation(db, clock, stranger.userId, made.token)).toMatchObject({
        workspace: { id: room.workspaceId },
        expiresAt: made.invitation.expiresAt,
        member: false,
      });
      const { membership: joined } = await acceptInvitation(db, clock, stranger.userId, made.token);
      expect(joined).toMatchObject({ workspace: { id: room.workspaceId }, role: 'member' });
      expect((await previewInvitation(db, clock, stranger.userId, made.token)).member).toBe(true);
      expect(
        (await auditOf(db, room.workspaceId)).filter((row) => row.action === 'member.joined'),
      ).toEqual([
        {
          action: 'member.joined',
          metadata: { via: 'invitation', invitationId: made.invitation.id },
        },
      ]);
    });
  });

  test('joining again is the same answer, written once; an owner opening their own link stays owner', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner6']);
      const owner = await as(db, room, 'in-owner6');
      const made = await createInvitation(db, clock, owner);
      const stranger = await aUserRow(db, 'in-stranger6');

      const first = await acceptInvitation(db, clock, stranger.userId, made.token);
      clock.advance(1_000);
      const repeated = await acceptInvitation(db, clock, stranger.userId, made.token);
      expect(repeated.membership).toEqual(first.membership);
      expect([...first.memberIds].sort()).toEqual([owner.userId, stranger.userId].sort());
      expect(repeated.memberIds).toEqual([]);
      expect(await acceptInvitation(db, clock, owner.userId, made.token)).toMatchObject({
        membership: { role: 'owner' },
        memberIds: [],
      });
      const joins = (await auditOf(db, room.workspaceId)).filter(
        (row) => row.action === 'member.joined',
      );
      expect(joins).toHaveLength(1);
    });
  });

  test('a link opens until its expiry and not at it, to the millisecond', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner7']);
      const made = await createInvitation(db, clock, await as(db, room, 'in-owner7'));
      const late = await aUserRow(db, 'in-late7');
      const onTime = await aUserRow(db, 'in-ontime7');

      clock.advance(TTL_MS - 1);
      expect((await acceptInvitation(db, clock, onTime.userId, made.token)).membership.role).toBe(
        'member',
      );
      clock.advance(1);
      expect(await refusal(previewInvitation(db, clock, late.userId, made.token))).toBe(
        'INVITATION_NOT_FOUND',
      );
      expect(await refusal(acceptInvitation(db, clock, late.userId, made.token))).toBe(
        'INVITATION_NOT_FOUND',
      );
    });
  });

  test('revoked, unknown, or its workspace deleted: the one refusal, and nobody joins', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner8']);
      const owner = await as(db, room, 'in-owner8');
      const revoked = await createInvitation(db, clock, owner);
      const orphaned = await createInvitation(db, clock, owner);
      await revokeInvitation(db, clock, owner, revoked.invitation.id);
      const stranger = await aUserRow(db, 'in-stranger8');

      expect(await refusal(acceptInvitation(db, clock, stranger.userId, revoked.token))).toBe(
        'INVITATION_NOT_FOUND',
      );
      const unknown = 'f'.repeat(64);
      expect(await refusal(acceptInvitation(db, clock, stranger.userId, unknown))).toBe(
        'INVITATION_NOT_FOUND',
      );
      await db
        .updateTable('workspaces')
        .set({ deleted_at: clock.now() })
        .where('id', '=', room.workspaceId)
        .execute();
      expect(await refusal(acceptInvitation(db, clock, stranger.userId, orphaned.token))).toBe(
        'INVITATION_NOT_FOUND',
      );
      const memberships = await db
        .selectFrom('workspace_members')
        .select('id')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', stranger.userId)
        .execute();
      expect(memberships).toEqual([]);
    });
  });

  /** Two tabs, one link, one person, at once: one membership and one record (real transactions). */
  test('the same person joining twice at once is one membership', async () => {
    const db = cloned.db;
    const clock = aMovableClock();
    const room = await aRoom(db, ['in-owner9']);
    const made = await createInvitation(db, clock, await as(db, room, 'in-owner9'));
    const stranger = await aUserRow(db, 'in-stranger9');
    const join = async (): Promise<string> =>
      (
        await atomicallyOn(db)(
          async (transaction) => await acceptIn(transaction, clock, stranger.userId, made.token),
        )
      ).membership.role;

    expect(await Promise.all([join(), join()])).toEqual(['member', 'member']);
    const rows = await db
      .selectFrom('workspace_members')
      .select('id')
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', stranger.userId)
      .execute();
    expect(rows).toHaveLength(1);
    const joins = (await auditOf(db, room.workspaceId)).filter(
      (row) => row.action === 'member.joined',
    );
    expect(joins).toHaveLength(1);
  });

  test('joining adds to no channel: a private one stays unseen, and a public one is joined by hand', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner10'], { type: 'private' });
      const made = await createInvitation(db, clock, await as(db, room, 'in-owner10'));
      const stranger = await aUserRow(db, 'in-stranger10');
      await acceptInvitation(db, clock, stranger.userId, made.token);

      const seen = await requireChannelById(db, stranger.userId, room.channelId).then(
        () => 'seen',
        (failure: unknown) => (failure instanceof AppError ? failure.body.code : 'other'),
      );
      expect(seen).toBe('CHANNEL_NOT_FOUND');
      const channels = await db
        .selectFrom('channel_members')
        .select('channel_id')
        .where('user_id', '=', stranger.userId)
        .execute();
      expect(channels).toEqual([]);
    });
  });

  test('a person removed after the link was made is not let back by it; a newer link lets them in', async () => {
    await withRollback(async (db) => {
      const clock = aMovableClock();
      const room = await aRoom(db, ['in-owner11']);
      const owner = await as(db, room, 'in-owner11');
      const old = await createInvitation(db, clock, owner);
      const person = await aUserRow(db, 'in-person11');
      await acceptInvitation(db, clock, person.userId, old.token);
      clock.advance(1_000);
      await atomicallyOn(db)(async (transaction) => {
        await removeMember(transaction, clock, owner, person.userId);
      });

      clock.advance(1_000);
      expect(await refusal(acceptInvitation(db, clock, person.userId, old.token))).toBe(
        'INVITATION_NOT_FOUND',
      );
      expect(await refusal(previewInvitation(db, clock, person.userId, old.token))).toBe(
        'INVITATION_NOT_FOUND',
      );
      const fresh = await createInvitation(db, clock, owner);
      expect((await acceptInvitation(db, clock, person.userId, fresh.token)).membership.role).toBe(
        'member',
      );
    });
  });
});

/**
 * Races, in real transactions on a database of the file's own. Each makes the order it tests
 * happen — the first transaction holds its lock until the second is seen waiting on it — rather
 * than hoping for it.
 */
describe('integration: revoking races', () => {
  const waitingOnALock = async (db: Executor): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await sql<{ waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
      if ((rows[0]?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline)
        throw new Error('the second transaction never waited on the first');
      await Bun.sleep(5);
    }
  };

  /** Runs `first` in a transaction held open until `second` waits on it; answers what `second` did. */
  const raced = async <T>(
    db: Executor,
    first: (transaction: Transaction) => Promise<void>,
    second: () => Promise<T>,
  ): Promise<T> => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const holder = atomicallyOn(db)(async (transaction) => {
      await first(transaction);
      begun();
      await held;
    });
    await started;
    const waiting = second();
    await waitingOnALock(db);
    release();
    await holder;
    return await waiting;
  };

  test('a revocation committed while a join waits refuses the join', async () => {
    const db = cloned.db;
    const clock = aMovableClock();
    const room = await aRoom(db, ['in-owner12']);
    const owner = await as(db, room, 'in-owner12');
    const made = await createInvitation(db, clock, owner);
    const stranger = await aUserRow(db, 'in-stranger12');

    const outcome = await raced(
      db,
      async (transaction) => {
        await revokeIn(transaction, clock, owner, made.invitation.id);
      },
      async () => await refusal(acceptInvitation(db, clock, stranger.userId, made.token)),
    );
    expect(outcome).toBe('INVITATION_NOT_FOUND');
  });

  test('two revocations at once are recorded once', async () => {
    const db = cloned.db;
    const clock = aMovableClock();
    const room = await aRoom(db, ['in-owner13']);
    const owner = await as(db, room, 'in-owner13');
    const made = await createInvitation(db, clock, owner);

    await raced(
      db,
      async (transaction) => {
        await revokeIn(transaction, clock, owner, made.invitation.id);
      },
      async () => {
        await revokeInvitation(db, clock, owner, made.invitation.id);
      },
    );
    const revocations = (await auditOf(db, room.workspaceId)).filter(
      (row) => row.action === 'invitation.revoked',
    );
    expect(revocations).toHaveLength(1);
  });

  test('an admin demoted while making a link is refused once the demotion commits', async () => {
    const db = cloned.db;
    const clock = aMovableClock();
    const room = await aRoom(db, ['in-owner14', 'in-admin14']);
    await db
      .updateTable('workspace_members')
      .set({ role: 'admin' })
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', room.members['in-admin14']?.userId ?? '')
      .execute();
    const owner = await as(db, room, 'in-owner14');
    // Read before the demotion, as a request that began before it would have.
    const admin = await as(db, room, 'in-admin14');

    const outcome = await raced(
      db,
      async (transaction) => {
        await changeRole(transaction, clock, owner, admin.userId, 'member');
      },
      async () => await refusal(createInvitation(db, clock, admin)),
    );
    expect(outcome).toBe('FORBIDDEN');
  });

  test('a person removed while joining by an older link stays out', async () => {
    const db = cloned.db;
    const clock = aMovableClock();
    const room = await aRoom(db, ['in-owner15', 'in-gone15']);
    const owner = await as(db, room, 'in-owner15');
    const made = await createInvitation(db, clock, owner);
    const gone = room.members['in-gone15']?.userId ?? '';
    clock.advance(1_000);

    const outcome = await raced(
      db,
      async (transaction) => {
        await removeMember(transaction, clock, owner, gone);
      },
      async () => await refusal(acceptInvitation(db, clock, gone, made.token)),
    );
    expect(outcome).toBe('INVITATION_NOT_FOUND');
  });
});
