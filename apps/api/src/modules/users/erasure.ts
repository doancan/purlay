/**
 * Erasing an account (D-27 §2, D-139 §5–§6, I-11): the person's own act, in one transaction.
 *
 * - **What is theirs goes.** The `users` columns that say who they are — the address to an
 *   unroutable placeholder, the name to `deleted-user-…`, the GitHub id and the profile cleared — every
 *   session revoked with its address and agent, the devices push reaches, the sign-in links waiting
 *   for the old address, what they saved and what they were told.
 * - **What the team holds stays**, under the anonymised row: their messages, reactions, memberships,
 *   incident roles and the trail. Erasure never cascades (D-9); content erasure is another act.
 * - **Asked for on purpose.** Their username, typed, and a session signed in within the last minutes:
 *   the one thing a forgotten session could do that cannot be undone.
 * - **A workspace keeps a live owner** (I-2). Each workspace they are in is locked in id order first, so
 *   two owners erasing at once cannot each count the other; the last live owner of a workspace with
 *   another live member is refused until they hand it over.
 *
 * After the commit the caller ends their sockets and tells each workspace (the ingress), as signing out
 * everywhere does (D-11).
 */
import { sql, type Transaction } from '@purlay/db';
import { ERASED_USERNAME_PREFIX, ERASURE_SIGN_IN_MINUTES } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { recordAudit } from '../audit/audit';
import { availableUsername } from '../auth/identity';
import { revokeAllSessions } from '../auth/sessions';
import { forgetSessions } from '../push/subscriptions';

/** What the ingress tells after the commit: whose sockets end, and which workspaces read again. */
export interface Erased {
  /** Whose sockets end: every one the person has, whatever session it holds. */
  readonly userId: string;
  readonly workspaces: readonly { readonly id: string; readonly memberIds: readonly string[] }[];
}

const invalid = (field: string, says: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The request did not match the contract.',
    details: { fields: { [field]: says } },
  });

export const eraseAccount = async (
  executor: Transaction,
  clock: Clock,
  caller: { readonly userId: string; readonly sessionId: string },
  confirm: string,
): Promise<Erased> => {
  const now = clock.now();
  // Read first, locking nothing: the checks refuse before anything is held.
  const person = await executor
    .selectFrom('users')
    .select(['id', 'username', 'email'])
    .where('id', '=', caller.userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  // A session resolves only for a live account, so this is a second request racing the first: done.
  if (person === undefined) return { userId: caller.userId, workspaces: [] };
  if (confirm !== person.username) throw invalid('confirm', 'is not your username');
  // The session as it is now — live, and signed in recently enough (D-139 §5) — held until the end, as
  // every write of the person's holds it (D-85).
  const session = await executor
    .selectFrom('sessions')
    .select('created_at')
    .where('id', '=', caller.sessionId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .forShare()
    .executeTakeFirst();
  if (session === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }
  if (now.getTime() - new Date(session.created_at).getTime() > ERASURE_SIGN_IN_MINUTES * 60_000) {
    throw new AppError({
      code: 'REAUTHENTICATION_REQUIRED',
      message: 'Sign in again to erase your account: this session is not recent enough.',
    });
  }

  // Locks in the order every other writer takes them, so none can close a cycle with this:
  // the address's sign-in links (a link being used holds its row, then the person's), the sessions
  // (a send holds its session, then the person's row), the workspaces in id order (a role change holds
  // its workspace, then names its actor), and only then the person's row.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`email-sign-in:${person.email}`}, 0))`.execute(
    executor,
  );
  await executor.deleteFrom('email_sign_ins').where('email', '=', person.email).execute();
  const sessionIds = await revokeAllSessions(executor, clock, person.id);
  const memberships = await executor
    .selectFrom('workspace_members')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select(['workspaces.id', 'workspace_members.role'])
    .where('workspace_members.user_id', '=', caller.userId)
    .orderBy('workspaces.id')
    .forUpdate(['workspaces'])
    .execute();
  const locked = await executor
    .selectFrom('users')
    .select('id')
    .where('id', '=', person.id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (locked === undefined) return { userId: person.id, workspaces: [] };

  const blocking: string[] = [];
  const unowned: string[] = [];
  for (const membership of memberships) {
    if (membership.role !== 'owner') continue;
    const others = await executor
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select([
        sql<string>`count(*) filter (where workspace_members.role = 'owner')`.as('owners'),
        sql<string>`count(*)`.as('members'),
      ])
      .where('workspace_members.workspace_id', '=', membership.id)
      .where('workspace_members.user_id', '<>', caller.userId)
      .where('users.deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(others.owners) > 0) continue;
    if (Number(others.members) > 0) blocking.push(membership.id);
    else unowned.push(membership.id);
  }
  if (blocking.length > 0) {
    throw new AppError({
      code: 'LAST_OWNER',
      message: 'You are the last owner of a workspace with other people in it: hand it over first.',
      details: { workspaceIds: blocking },
    });
  }
  // A workspace left with nobody live in it: its open links stop opening, or anyone holding one would
  // join a workspace nobody can ever own again (I-2).
  if (unowned.length > 0) {
    await executor
      .updateTable('workspace_invitations')
      .set({ revoked_at: now })
      .where('workspace_id', 'in', unowned)
      .where('revoked_at', 'is', null)
      .execute();
  }

  const placeholder = await availableUsername(
    executor,
    `${ERASED_USERNAME_PREFIX}${person.id.replace(/-/g, '').slice(0, 8)}`,
    person.id,
  );
  await executor
    .updateTable('users')
    .set({
      email: `erased-${person.id}@erased.invalid`,
      username: placeholder,
      display_name: placeholder,
      avatar_url: null,
      title: null,
      time_zone: null,
      status_text: null,
      last_seen_at: null,
      github_id: null,
      deleted_at: now,
      updated_at: now,
    })
    .where('id', '=', person.id)
    .execute();

  await executor
    .updateTable('sessions')
    .set({ ip_address: null, user_agent: null })
    .where('user_id', '=', person.id)
    .execute();
  await forgetSessions(executor, sessionIds);
  await executor.deleteFrom('push_subscriptions').where('user_id', '=', person.id).execute();
  await executor.deleteFrom('saved_messages').where('user_id', '=', person.id).execute();
  await executor.deleteFrom('thread_follows').where('user_id', '=', person.id).execute();
  await executor.deleteFrom('notifications').where('user_id', '=', person.id).execute();

  const workspaces: { id: string; memberIds: string[] }[] = [];
  for (const membership of memberships) {
    await recordAudit(executor, clock, {
      workspaceId: membership.id,
      actorUserId: person.id,
      action: 'account.erased',
      targetType: 'user',
      targetId: person.id,
    });
    const members = await executor
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', membership.id)
      .where('user_id', '<>', person.id)
      .execute();
    workspaces.push({ id: membership.id, memberIds: members.map((member) => member.user_id) });
  }
  return { userId: person.id, workspaces };
};
