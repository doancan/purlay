/**
 * Invitation links (D-115, closing O-2): how a person enters a workspace somebody else made.
 *
 * - **A link is a secret**, made and kept as a session's is (`platform/tokens.ts`): handed out once,
 *   only its digest stored. It travels in bodies and in the page's fragment, never in a path the
 *   request log writes.
 * - **It lets anyone signed in who holds it join as a member**, into no channel, until it expires
 *   (`INVITATION_TTL_DAYS`) or an owner or admin revokes it. A role is changed afterwards by the
 *   people who manage members (#51); a link never makes an admin.
 * - **Joining never changes a membership**: somebody already in stays what they are, as open join
 *   does (D-37). **A person removed after the link was made is not let back by it** — removal is a
 *   decision a link handed out earlier must not undo; a new link can.
 * - **A link that does not open is one answer**: unknown, expired, revoked, its workspace deleted,
 *   or its holder removed since — `404 INVITATION_NOT_FOUND`, saying nothing about which.
 * - **Revoking wins a race with joining**: joining reads the link `FOR SHARE`, so a revocation
 *   committed first refuses it, and one waiting commits after the join it could not stop.
 * - Making, revoking and joining are audited in the transaction that does them (D-26); each takes a
 *   transaction, because each writes twice (#232).
 */
import type {
  Database,
  Executor,
  Expression,
  ExpressionBuilder,
  SqlBool,
  Transaction,
} from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  INVITATION_TTL_DAYS,
  PAGE_LIMIT,
  messageId,
  type CreatedInvitation,
  type Invitation,
  type InvitationPage,
  type InvitationPreview,
  type OlderPageQuery,
  type Membership,
  Uuid,
} from '@purlay/types';
import { DAY_MS, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { workspaceNotFound, type WorkspaceContext } from '../../platform/tenancy';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { recordAudit } from '../audit/audit';
import { membershipsOf } from './workspaces';

export const notFound = (): AppError =>
  new AppError({
    code: 'INVITATION_NOT_FOUND',
    message: 'That invitation does not open: it may have expired or been revoked.',
  });

/**
 * Whether a link still opens, as a condition on its row and its workspace's: not revoked, not past its
 * expiry, its workspace not deleted. One home for the three, read by the preview and the join (`opened`)
 * and by every use of an invitation passport (`invitation-passport.ts`), so a link that stops opening
 * stops opening them too — the same words, never a copy of them.
 */
export const linkOpens = (
  eb: ExpressionBuilder<Database, 'workspace_invitations' | 'workspaces'>,
  now: Date,
): Expression<SqlBool> =>
  eb.and([
    eb('workspace_invitations.revoked_at', 'is', null),
    eb('workspace_invitations.expires_at', '>', now),
    eb('workspaces.deleted_at', 'is', null),
  ]);

const forbidden = (): AppError =>
  new AppError({ code: 'FORBIDDEN', message: 'Only an owner or an admin manages invitations.' });

/** Managing links is an owner's and an admin's, after membership has made the workspace exist. */
const refuseMembers = (context: WorkspaceContext): void => {
  if (context.role === 'member') throw forbidden();
};

/**
 * The same, for a write: the caller's role as it is now, read `FOR SHARE` in the writing
 * transaction — a demotion committed after the request began is seen, and one still to commit
 * waits for this (#51 reads roles under a lock for the same reason).
 */
const refuseMembersNow = async (
  transaction: Transaction,
  context: WorkspaceContext,
): Promise<void> => {
  const row = await transaction
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .forShare()
    .executeTakeFirst();
  // Gone from the workspace since the guard let them in: outside it, as anybody outside is (D-21).
  if (row === undefined) throw workspaceNotFound();
  if (row.role === 'member') throw forbidden();
};

interface InvitationRow {
  readonly id: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly user_id: string | null;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
}

const asInvitation = (row: InvitationRow): Invitation => ({
  id: row.id,
  createdBy:
    row.user_id === null || row.username === null || row.display_name === null
      ? null
      : {
          id: row.user_id,
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
        },
  createdAt: new Date(row.created_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
});

/** The context's links that still let people in, with who made each, newest first. */
const openInvitations = async (
  executor: Executor,
  context: WorkspaceContext,
  now: Date,
  only: { readonly id: string } | { readonly before: string | undefined; readonly limit: number },
): Promise<InvitationRow[]> => {
  let statement = executor
    .selectFrom('workspace_invitations')
    .leftJoin('users', 'users.id', 'workspace_invitations.created_by')
    .select([
      'workspace_invitations.id',
      'workspace_invitations.created_at',
      'workspace_invitations.expires_at',
      'users.id as user_id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
    ])
    .where('workspace_invitations.workspace_id', '=', context.workspaceId)
    .where('workspace_invitations.revoked_at', 'is', null)
    .where('workspace_invitations.expires_at', '>', now)
    .orderBy('workspace_invitations.id', 'desc');
  if ('id' in only) {
    statement = statement.where('workspace_invitations.id', '=', only.id);
  } else {
    if (only.before !== undefined) {
      statement = statement.where('workspace_invitations.id', '<', only.before);
    }
    statement = statement.limit(only.limit);
  }
  return await statement.execute();
};

/** `POST …/invitations` — a new link; its token is in this answer and nowhere else, ever. */
export const createInvitation = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
): Promise<CreatedInvitation> => {
  await refuseMembersNow(transaction, context);
  const now = clock.now();
  const token = randomToken();
  const id = messageId(now);
  await transaction
    .insertInto('workspace_invitations')
    .values({
      id,
      workspace_id: context.workspaceId,
      token_hash: await tokenDigest(token),
      created_by: context.userId,
      created_at: now,
      expires_at: new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS),
    })
    .execute();
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'invitation.created',
    targetType: 'invitation',
    targetId: id,
  });
  const [row] = await openInvitations(transaction, context, now, { id });
  // Written above, in this transaction, with an expiry ahead of now.
  if (row === undefined) throw new Error('an invitation just made is missing');
  return { invitation: asInvitation(row), token };
};

/** `GET …/invitations` — the links that still let people in, newest first, a page at a time. */
export const listInvitations = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
  query: OlderPageQuery,
): Promise<InvitationPage> => {
  refuseMembers(context);
  const limit = query.limit ?? PAGE_LIMIT.default;
  const rows = await openInvitations(executor, context, clock.now(), {
    before: query.before,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    data: page.map(asInvitation),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};

/**
 * `DELETE …/invitations/:invitationId` — the link stops letting people in. Revoked already is done
 * already, and recorded once however many ask at once; a link of another workspace is not found.
 */
export const revokeInvitation = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  invitationId: string,
): Promise<void> => {
  await refuseMembersNow(transaction, context);
  // Not an id at all is the same as no such link — never a database error.
  if (!Value.Check(Uuid, invitationId)) throw notFound();
  const revoked = await transaction
    .updateTable('workspace_invitations')
    .set({ revoked_at: clock.now() })
    .where('workspace_id', '=', context.workspaceId)
    .where('id', '=', invitationId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (revoked === undefined) {
    const exists = await transaction
      .selectFrom('workspace_invitations')
      .select('id')
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '=', invitationId)
      .executeTakeFirst();
    if (exists === undefined) throw notFound();
    return;
  }
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'invitation.revoked',
    targetType: 'invitation',
    targetId: revoked.id,
  });
};

interface Opened {
  readonly invitationId: string;
  readonly expiresAt: Date | string;
  readonly workspace: InvitationPreview['workspace'];
}

/**
 * The workspace a token opens for this person now, or the one refusal. Read `FOR SHARE` when it is
 * about to be used — on the link's row *and the workspace's*, deliberately: the first serialises a
 * join with a revocation, the second with a removal, which locks the workspace row `FOR UPDATE`
 * (#51), so the trail read below sees a removal that committed first. Narrowing the lock to the
 * link (`.of(…)`) would reopen that race.
 */
const opened = async (
  executor: Executor,
  now: Date,
  userId: string,
  token: string,
  lock: boolean,
): Promise<Opened> => {
  const statement = executor
    .selectFrom('workspace_invitations')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_invitations.workspace_id')
    .select([
      'workspace_invitations.id as invitation_id',
      'workspace_invitations.created_at',
      'workspace_invitations.expires_at',
      'workspaces.id',
      'workspaces.name',
      'workspaces.slug',
      'workspaces.avatar_url',
    ])
    .where('workspace_invitations.token_hash', '=', await tokenDigest(token))
    .where((eb) => linkOpens(eb, now));
  const row = await (lock ? statement.forShare() : statement).executeTakeFirst();
  if (row === undefined) throw notFound();
  // Removed since the link was made: the removal stands (written in its transaction, D-26).
  const removed = await executor
    .selectFrom('audit_log')
    .select('id')
    .where('workspace_id', '=', row.id)
    .where('action', '=', 'member.removed')
    .where('target_id', '=', userId)
    .where('created_at', '>=', row.created_at)
    .executeTakeFirst();
  if (removed !== undefined) throw notFound();
  return {
    invitationId: row.invitation_id,
    expiresAt: row.expires_at,
    workspace: { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatar_url },
  };
};

/** `POST /api/invitations/preview` — what the link opens, before anybody joins. */
export const previewInvitation = async (
  executor: Executor,
  clock: Clock,
  userId: string,
  token: string,
): Promise<InvitationPreview> => {
  const { workspace, expiresAt } = await opened(executor, clock.now(), userId, token, false);
  const member = await executor
    .selectFrom('workspace_members')
    .select('id')
    .where('workspace_id', '=', workspace.id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return {
    workspace,
    expiresAt: new Date(expiresAt).toISOString(),
    member: member !== undefined,
  };
};

/**
 * `POST /api/invitations/accept` — in, as a member; answered with the membership as `/api/me` lists
 * it. Again is the same answer: somebody already in stays as they are, and nothing is recorded twice.
 */
export const acceptInvitation = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  token: string,
): Promise<Membership> => {
  const now = clock.now();
  const { workspace, invitationId } = await opened(transaction, now, userId, token, true);
  const inserted = await transaction
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: userId, role: 'member', joined_at: now })
    .onConflict((conflict) => conflict.columns(['workspace_id', 'user_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted !== undefined) {
    await recordAudit(transaction, clock, {
      workspaceId: workspace.id,
      actorUserId: userId,
      action: 'member.joined',
      targetType: 'user',
      targetId: userId,
      metadata: { via: 'invitation', invitationId },
    });
  }
  const [membership] = await membershipsOf(transaction, clock, userId, workspace.id);
  // Inserted or already there, in this transaction: a membership that is not found is a bug.
  if (membership === undefined) throw new Error('a membership just made is missing');
  return membership;
};
