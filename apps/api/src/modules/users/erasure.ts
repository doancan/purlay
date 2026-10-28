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
import { inviterMailKey } from '../workspaces/invitation-mail';
import { addressCounterKey } from '../auth/magic-link';
import { passportAddressDigest } from '../workspaces/invitation-passport';
import { addressAttemptsPrefix } from '../auth/password-attempts';
import { revokeAllSessions } from '../auth/sessions';

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

  // Locks in the order every other writer takes them, so none can close a cycle with this: the
  // sessions (a send holds its session, then the person's row), the workspaces in id order (a role
  // change holds its workspace, then names its actor), and only then the person's row.
  // The library's one-time tokens never carry the address in `identifier` (`magic-link:<digest>`,
  // `reset-password:<token>`); a magic link's `value` holds it as JSON, and a password reset's holds the
  // user's id. Matched here, before the address is replaced below: the address read out of the JSON and
  // compared whole, so no other address is a near miss of it, and a value that is not JSON — a reset's —
  // is stepped over, never cast (the `case` decides before the cast is made).
  await sql`delete from verifications
    where value = ${person.id}
       or case when pg_input_is_valid(value, 'jsonb')
               then lower((value::jsonb) ->> 'email') end = ${person.email}`.execute(executor);
  // And how many links the address was sent this hour, kept by its digest.
  await executor
    .deleteFrom('rate_limits')
    .where('key', '=', await addressCounterKey(person.email))
    .execute();
  // And the passports an invitation made for the address (D-179 §5), kept by its digest: read here, before
  // the tombstone replaces the address, or nothing could find them.
  const passportDigest = await passportAddressDigest(person.email);
  if (passportDigest !== undefined) {
    await executor
      .deleteFrom('invitation_passports')
      .where('address_digest', '=', passportDigest)
      .execute();
  }
  // And the codes that handed the person's session to the native application (D-191): by their id, since the
  // tombstone keeps the row. Digests, long since spent or expired, but theirs.
  await executor.deleteFrom('native_authorizations').where('user_id', '=', person.id).execute();
  // And the wrong passwords counted for the address, from whichever clients: kept under its digest.
  await executor
    .deleteFrom('rate_limits')
    .where('key', 'like', `${await addressAttemptsPrefix(person.email)}%`)
    .execute();
  // And how many invitation letters the person sent today: kept under their id.
  await executor.deleteFrom('rate_limits').where('key', '=', inviterMailKey(person.id)).execute();
  // Held now, in this order, and ended last: a trail row naming a session already deleted would be
  // refused by its key. Deleting them nulls that `session_id` in this same transaction (D-116 as
  // amended by D-179), so the trail of an erasure keeps who acted, not the session.
  await executor
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', person.id)
    .forUpdate()
    .execute();
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
      github_login: null,
      github_connected_at: null,
      // Marks of the account that was: the verified mark says an address was proved, and the flag grants
      // server authority, which must not outlive the person (D-139 §5, D-179).
      email_verified: false,
      is_server_admin: false,
      deleted_at: now,
      updated_at: now,
    })
    .where('id', '=', person.id)
    .execute();

  await executor.deleteFrom('push_subscriptions').where('user_id', '=', person.id).execute();
  await executor.deleteFrom('scheduled_messages').where('user_id', '=', person.id).execute();
  await executor.deleteFrom('saved_messages').where('user_id', '=', person.id).execute();
  await executor.deleteFrom('thread_follows').where('user_id', '=', person.id).execute();
  await executor.deleteFrom('notifications').where('user_id', '=', person.id).execute();
  // A provider's account id is who they are on GitHub, and a credential account holds a password's hash;
  // left behind, the pair would also hand a returning GitHub sign-in the erased account (D-38, D-179).
  await executor.deleteFrom('accounts').where('user_id', '=', person.id).execute();
  // A link that would verify the address they had as the setup's administrator (D-179 §4.3): the row
  // outlives a soft deletion, which its key's cascade does not see.
  await executor.deleteFrom('admin_email_verification').where('user_id', '=', person.id).execute();

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
  // Every session of the person ends, the one that asked included, and takes its address, browser and
  // devices with its row (D-139 §5, 0024).
  await revokeAllSessions(executor, person.id);
  return { userId: person.id, workspaces };
};
