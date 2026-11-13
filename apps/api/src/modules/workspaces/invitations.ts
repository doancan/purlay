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
import { sql } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  INVITATION_TTL_DAYS,
  PAGE_LIMIT,
  messageId,
  normalisedMailbox,
  type CreatedInvitation,
  type CreatedGuestInvitation,
  type Invitation,
  type InvitationPage,
  type InvitationPreview,
  type OlderPageQuery,
  type Membership,
  Uuid,
} from '@purlay/types';
import { DAY_MS, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import type { WorkspaceChannels } from './channels-port';
import { requireInvitationManager, requireInvitationManagerNow } from './invitation-manager';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { recordAudit } from '../audit/audit';
import { recordInvitationApplicant } from './invitation-delivery';
import { membershipsOf } from './workspaces';
import { requireGuestAdmissionReady } from './guest-readiness';
import { requireWorkspaceCapabilityNow } from './provisioning/authority';
import {
  requireLegacyAdmissionOpen,
  recordLegacyManualAdmission,
} from './provisioning/legacy-writers';

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
    eb.or([
      eb('workspace_invitations.access_kind', '=', 'member'),
      eb.and([
        eb('workspace_invitations.access_kind', '=', 'guest'),
        eb.or([
          eb('workspace_invitations.guest_access_expires_at', 'is', null),
          eb('workspace_invitations.guest_access_expires_at', '>', now),
        ]),
        eb.exists(
          eb
            .selectFrom('workspace_members as inviter')
            .innerJoin('users as inviter_account', 'inviter_account.id', 'inviter.user_id')
            .select('inviter.user_id')
            .whereRef('inviter.workspace_id', '=', 'workspace_invitations.workspace_id')
            .whereRef('inviter.user_id', '=', 'workspace_invitations.created_by')
            .where('inviter.access_kind', '=', 'member')
            .where('inviter.role', 'in', ['owner', 'admin'])
            .where('inviter_account.deleted_at', 'is', null)
            .where('inviter_account.suspended_at', 'is', null),
        ),
      ]),
    ]),
  ]);

interface InvitationRow {
  readonly access_kind: string;
  readonly guest_channel_count: number | null;
  readonly guest_access_expires_at: Date | string | null;
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
  ...(row.access_kind !== 'guest'
    ? {}
    : {
        guest: {
          channelCount: row.guest_channel_count ?? 0,
          accessExpiresAt:
            row.guest_access_expires_at === null
              ? null
              : new Date(row.guest_access_expires_at).toISOString(),
        },
      }),
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
      'workspace_invitations.access_kind',
      'workspace_invitations.guest_access_expires_at',
      'users.id as user_id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
    ])
    .select(
      sql<number | null>`cardinality(workspace_invitations.guest_channels)`.as(
        'guest_channel_count',
      ),
    )
    .where('workspace_invitations.workspace_id', '=', context.workspaceId)
    .where('workspace_invitations.revoked_at', 'is', null)
    .where('workspace_invitations.expires_at', '>', now)
    .orderBy('workspace_invitations.id', 'desc');
  if ('id' in only) {
    statement = statement.where('workspace_invitations.id', '=', only.id);
  } else {
    statement = statement.where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('workspace_invitation_mail_attempts')
            .select('id')
            .whereRef('invitation_id', '=', 'workspace_invitations.id'),
        ),
      ),
    );
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
  /** Server-owned scope, validated and locked by the guest admission service. */
  guest?: { readonly access: CreatedGuestInvitation['guest']; readonly moduleId: string },
): Promise<CreatedInvitation> => {
  if (guest !== undefined) requireInvitationManager(context);
  await requireInvitationManagerNow(transaction, context);
  const now = clock.now();
  const token = randomToken();
  const id = messageId(now);
  await transaction
    .insertInto('workspace_invitations')
    .values({
      id,
      workspace_id: context.workspaceId,
      token_hash: `${guest === undefined ? '' : 'guest:'}${await tokenDigest(token)}`,
      created_by: context.userId,
      created_at: now,
      expires_at: new Date(
        Math.min(
          now.getTime() + INVITATION_TTL_DAYS * DAY_MS,
          guest?.access.accessExpiresAt == null
            ? Infinity
            : new Date(guest.access.accessExpiresAt).getTime(),
        ),
      ),
      ...(guest === undefined
        ? {}
        : {
            access_kind: 'guest',
            guest_email: guest.access.email,
            guest_channels: [...guest.access.channelIds],
            guest_modules: [guest.moduleId],
            guest_access_expires_at: guest.access.accessExpiresAt,
          }),
    })
    .execute();
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'invitation.created',
    targetType: 'invitation',
    targetId: id,
    ...(guest === undefined
      ? {}
      : {
          metadata: {
            accessKind: 'guest',
            channelIds: guest.access.channelIds.join(','),
            accessExpiresAt: guest.access.accessExpiresAt ?? 'none',
          },
        }),
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
  await requireWorkspaceCapabilityNow(executor, context, 'members.invite');
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
  await requireInvitationManagerNow(transaction, context);
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
  readonly guest?: {
    readonly access: CreatedGuestInvitation['guest'];
    readonly modules: readonly string[];
    readonly manager: WorkspaceContext;
  };
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
  const digest = await tokenDigest(token);
  const statement = executor
    .selectFrom('workspace_invitations')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_invitations.workspace_id')
    .select([
      'workspace_invitations.id as invitation_id',
      'workspace_invitations.created_at',
      'workspace_invitations.expires_at',
      'workspace_invitations.access_kind',
      'workspace_invitations.guest_email',
      'workspace_invitations.guest_channels',
      'workspace_invitations.guest_modules',
      'workspace_invitations.guest_access_expires_at',
      'workspace_invitations.created_by',
      'workspaces.id',
      'workspaces.name',
      'workspaces.slug',
      'workspaces.avatar_url',
    ])
    .where('workspace_invitations.token_hash', 'in', [digest, `guest:${digest}`])
    .where((eb) => linkOpens(eb, now));
  const row = await (lock ? statement.forShare() : statement).executeTakeFirst();
  if (row === undefined) throw notFound();
  let guest: Opened['guest'];
  if (row.access_kind === 'guest') {
    if (
      row.guest_email === null ||
      row.guest_channels === null ||
      row.guest_modules === null ||
      row.created_by === null
    )
      throw notFound();
    const recipient = await executor
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .where('email_verified', '=', true)
      .where('deleted_at', 'is', null)
      .where('suspended_at', 'is', null)
      .executeTakeFirst();
    if (recipient === undefined || normalisedMailbox(recipient.email) !== row.guest_email)
      throw notFound();
    const manager = await requireWorkspaceMembership(executor, row.created_by, row.id).catch(
      (error: unknown) => {
        if (error instanceof AppError && error.status === 404) throw notFound();
        throw error;
      },
    );
    if (manager.role === 'member') throw notFound();
    guest = {
      manager,
      modules: row.guest_modules,
      access: {
        email: row.guest_email,
        channelIds: row.guest_channels,
        accessExpiresAt:
          row.guest_access_expires_at === null
            ? null
            : new Date(row.guest_access_expires_at).toISOString(),
      },
    };
  }
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
    ...(guest === undefined ? {} : { guest }),
  };
};

/** `POST /api/invitations/preview` — what the link opens, before anybody joins. */
export const previewInvitation = async (
  executor: Executor,
  clock: Clock,
  userId: string,
  token: string,
): Promise<InvitationPreview> => {
  const { workspace, expiresAt, guest } = await opened(executor, clock.now(), userId, token, false);
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
    ...(guest === undefined
      ? {}
      : {
          guest: {
            channelCount: guest.access.channelIds.length,
            accessExpiresAt: guest.access.accessExpiresAt,
          },
        }),
  };
};

/** The membership and the people whose cached member lists changed. */
export interface AcceptedInvitation {
  readonly membership: Membership;
  /** Empty for an existing member: repeated acceptance changes nothing. */
  readonly memberIds: readonly string[];
}

/**
 * `POST /api/invitations/accept` — in, as a member; answered with the membership as `/api/me` lists
 * it. Again is the same answer: somebody already in stays as they are, and nothing is recorded twice.
 */
export const acceptInvitation = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  token: string,
  effective?: EntitlementPolicy['effective'],
  channels?: WorkspaceChannels,
  guestAccessReady = false,
): Promise<AcceptedInvitation> => {
  const now = clock.now();
  // A guest locks its selected conversations before the workspace mutex used by role changes.
  const isGuest = await transaction
    .selectFrom('workspace_invitations')
    .select('id')
    .where('token_hash', '=', `guest:${await tokenDigest(token)}`)
    .executeTakeFirst();
  if (isGuest !== undefined) {
    const pending = await opened(transaction, now, userId, token, false);
    if (
      pending.guest === undefined ||
      channels?.guests === undefined ||
      pending.guest.modules.length !== 1 ||
      pending.guest.modules[0] !== channels.guests.moduleId
    )
      throw notFound();
    await channels.guests
      .prepare(transaction, pending.guest.manager, pending.guest.access.channelIds)
      .catch((error: unknown) => {
        if (error instanceof AppError && (error.status === 404 || error.status === 403))
          throw notFound();
        throw error;
      });
  }
  const { workspace, invitationId, guest, expiresAt } = await opened(
    transaction,
    now,
    userId,
    token,
    true,
  );
  // Lock waits are real time: the arrival of the request is not its admission/history instant.
  const joinedAt = clock.now();
  if (
    new Date(expiresAt) <= joinedAt ||
    (guest?.access.accessExpiresAt != null && new Date(guest.access.accessExpiresAt) <= joinedAt)
  )
    throw notFound();
  if (guest !== undefined && !guestAccessReady) {
    const existing = await transaction
      .selectFrom('workspace_members')
      .select('id')
      .where('workspace_id', '=', workspace.id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    // Reopening an already accepted link does not create or reactivate a membership.
    if (existing === undefined) requireGuestAdmissionReady(guestAccessReady);
  }
  await requireLegacyAdmissionOpen(transaction, workspace.id, userId);
  const inserted = await transaction
    .insertInto('workspace_members')
    .values({
      workspace_id: workspace.id,
      user_id: userId,
      role: 'member',
      joined_at: joinedAt,
      ...(guest === undefined
        ? {}
        : {
            access_kind: 'guest',
            guest_since: joinedAt,
            guest_expires_at: guest.access.accessExpiresAt,
            guest_modules: [...guest.modules],
          }),
    })
    .onConflict((conflict) => conflict.columns(['workspace_id', 'user_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted !== undefined) {
    await recordLegacyManualAdmission(transaction, clock, workspace.id, userId);
    if (guest !== undefined) {
      if (channels?.guests === undefined) throw notFound();
      await channels.guests.grant(
        transaction,
        clock,
        guest.manager,
        userId,
        guest.access.channelIds,
        true,
      );
    }
    await recordAudit(transaction, clock, {
      workspaceId: workspace.id,
      actorUserId: userId,
      action: 'member.joined',
      targetType: 'user',
      targetId: userId,
      metadata: {
        via: 'invitation',
        invitationId,
        ...(guest === undefined
          ? {}
          : { accessKind: 'guest', channelIds: guest.access.channelIds.join(',') }),
      },
    });
  }
  await recordInvitationApplicant(transaction, clock, userId, invitationId, true);
  const [membership] = await membershipsOf(transaction, clock, userId, workspace.id, effective);
  // Inserted or already there, in this transaction: a membership that is not found is a bug.
  if (membership === undefined) throw notFound();
  const members =
    inserted === undefined
      ? []
      : await transaction
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', '=', workspace.id)
          .execute();
  return { membership, memberIds: members.map((member) => member.user_id) };
};
