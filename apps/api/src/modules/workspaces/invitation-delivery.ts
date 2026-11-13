/** Private, bounded invitation evidence. No address is matched to an account until its verified owner uses the link. */
import type { Database, Executor, Transaction, SelectQueryBuilder } from '@purlay/db';
import { sql } from '@purlay/db';
import type {
  InvitationDelivery,
  InvitationDeliveryPage,
  InvitationRecipientPage,
  InvitationRecipientQuery,
  InvitationRecipientStatus,
  OlderPageQuery,
} from '@purlay/types';
import { PAGE_LIMIT, messageId, messageIdTime, normalisedMailbox } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { MailReceipt } from '../../platform/mail';
import { AppError } from '../../platform/errors';
import { requireWorkspaceCapabilityNow } from './provisioning/authority';
import { literalPattern } from '../../platform/like-pattern';

/** A process interrupted before its receipt committed leaves evidence of uncertainty, never invented success. */
export const INVITATION_RECEIPT_WAIT_MS = 120_000;

interface AttemptRow {
  readonly id: string;
  readonly created_at: Date;
  readonly result: string;
  readonly finished_at: Date | null;
  readonly failure: string | null;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}
const attempts = (
  db: Executor,
): SelectQueryBuilder<
  Database & {
    a: Database['workspace_invitation_mail_attempts'];
    i: Database['workspace_invitations'];
  },
  'a' | 'i',
  AttemptRow
> =>
  db
    .selectFrom('workspace_invitation_mail_attempts as a')
    .innerJoin('workspace_invitations as i', 'i.id', 'a.invitation_id')
    .select([
      'a.id',
      'a.created_at',
      'a.result',
      'a.finished_at',
      'a.failure',
      'i.expires_at',
      'i.revoked_at',
    ]);
const iso = (date: Date | string | null): string | null =>
  date === null ? null : new Date(date).toISOString();
const delivery = (row: AttemptRow, now: Date): InvitationDelivery => ({
  id: row.id,
  createdAt: new Date(row.created_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
  revokedAt: iso(row.revoked_at),
  result:
    row.result === 'queued' &&
    now.getTime() - new Date(row.created_at).getTime() >= INVITATION_RECEIPT_WAIT_MS
      ? 'unknown'
      : (row.result as 'queued' | 'accepted' | 'failed'),
  finishedAt: iso(row.finished_at),
  failure: row.failure as InvitationDelivery['failure'],
});

export const addInvitationAttempt = async (
  tx: Transaction,
  clock: Clock,
  workspaceId: string,
  recipientId: string,
  invitationId: string,
  after?: string,
): Promise<string> => {
  // UUIDv7 randomness is not monotonic within one millisecond. Resend is serialized on the
  // previous link, so advance its ordering instant even when the clock is equal or moved back.
  const id = messageId(
    new Date(Math.max(clock.now().getTime(), after === undefined ? 0 : messageIdTime(after) + 1)),
  );
  await tx
    .insertInto('workspace_invitation_mail_attempts')
    .values({
      id,
      workspace_id: workspaceId,
      recipient_id: recipientId,
      invitation_id: invitationId,
      created_at: clock.now(),
      result: 'queued',
    })
    .execute();
  return id;
};

const safeFailure = (code: string): NonNullable<InvitationDelivery['failure']> => {
  switch (code) {
    case 'EAUTH':
      return 'authentication';
    case 'EENVELOPE':
      return 'recipient';
    case 'EMESSAGE':
      return 'message';
    case 'ETLS':
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return 'tls';
    case 'ECONNECTION':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
      return 'connection';
    default:
      return 'unknown';
  }
};

/** Only allowlisted categories persist: SMTP messages/codes can echo addresses and credentials. */
export const finishInvitationAttempt = async (
  db: Executor,
  clock: Clock,
  attemptId: string,
  receipt: MailReceipt,
): Promise<void> => {
  await db
    .updateTable('workspace_invitation_mail_attempts')
    .set({
      result: receipt.accepted ? 'accepted' : 'failed',
      finished_at: clock.now(),
      failure: receipt.accepted ? null : safeFailure(receipt.code),
    })
    .where('id', '=', attemptId)
    .where('result', '=', 'queued')
    .execute();
};

export const listInvitationRecipients = async (
  db: Executor,
  clock: Clock,
  context: WorkspaceContext,
  query: InvitationRecipientQuery,
): Promise<InvitationRecipientPage> => {
  await requireWorkspaceCapabilityNow(db, context, 'members.invite');
  const now = clock.now();
  const status = sql<InvitationRecipientStatus>`case
    when r.joined_at is not null then 'joined'
    when applicant.deleted_at is null and applicant.admission_state is not null then applicant.admission_state
    when last.revoked_at is not null then 'revoked'
    when last.expires_at <= ${now} then 'expired'
    when last.result = 'queued' and last.created_at <= ${new Date(now.getTime() - INVITATION_RECEIPT_WAIT_MS)} then 'unknown'
    else last.result end`;
  const limit = query.limit ?? PAGE_LIMIT.default;
  let statement = db
    .selectFrom('workspace_invitation_recipients as r')
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('workspace_invitation_mail_attempts as a')
          .innerJoin('workspace_invitations as i', 'i.id', 'a.invitation_id')
          .select([
            'a.id',
            'a.created_at',
            'a.result',
            'a.finished_at',
            'a.failure',
            'i.expires_at',
            'i.revoked_at',
            'i.access_kind',
            'i.guest_access_expires_at',
          ])
          .select(sql<number | null>`cardinality(i.guest_channels)`.as('guest_channel_count'))
          .whereRef('a.recipient_id', '=', 'r.id')
          .whereRef('a.workspace_id', '=', 'r.workspace_id')
          .orderBy('a.id', 'desc')
          .limit(1)
          .as('last'),
      (join) => join.onTrue(),
    )
    .leftJoin('users as applicant', 'applicant.id', 'r.applicant_user_id')
    .select([
      'r.id as recipient_id',
      'r.email',
      'r.created_at as recipient_created_at',
      'r.requested_at',
      'r.joined_at',
      'applicant.admission_state',
      'applicant.deleted_at',
      'last.id',
      'last.created_at',
      'last.result',
      'last.finished_at',
      'last.failure',
      'last.expires_at',
      'last.revoked_at',
      'last.access_kind',
      'last.guest_access_expires_at',
      'last.guest_channel_count',
    ])
    .select(status.as('status'))
    .where('r.workspace_id', '=', context.workspaceId)
    .orderBy('r.id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) statement = statement.where('r.id', '<', query.before);
  if (query.q?.trim())
    statement = statement.where('r.email', 'ilike', literalPattern(query.q.trim()));
  if (query.status !== undefined) statement = statement.where(status, '=', query.status);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => ({
      id: row.recipient_id,
      status: row.status,
      address: row.email,
      ...(row.access_kind !== 'guest'
        ? {}
        : {
            guest: {
              channelCount: row.guest_channel_count ?? 0,
              accessExpiresAt: iso(row.guest_access_expires_at),
            },
          }),
      createdAt: new Date(row.recipient_created_at).toISOString(),
      requestedAt: iso(row.requested_at),
      joinedAt: iso(row.joined_at),
      admission:
        row.deleted_at === null
          ? (row.admission_state as 'pending' | 'approved' | 'denied' | null)
          : null,
      latest: delivery(row, now),
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.recipient_id ?? null) : null,
  };
};

const requireInvitationRecipient = async (
  db: Executor,
  context: WorkspaceContext,
  recipientId: string,
): Promise<void> => {
  await requireWorkspaceCapabilityNow(db, context, 'members.invite');
  const row = await db
    .selectFrom('workspace_invitation_recipients')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .where('id', '=', recipientId)
    .executeTakeFirst();
  if (row === undefined)
    throw new AppError({
      code: 'INVITATION_NOT_FOUND',
      message: 'That invitation recipient was not found.',
    });
};

export const listInvitationDeliveries = async (
  db: Executor,
  clock: Clock,
  context: WorkspaceContext,
  recipientId: string,
  query: OlderPageQuery,
): Promise<InvitationDeliveryPage> => {
  await requireInvitationRecipient(db, context, recipientId);
  const limit = query.limit ?? PAGE_LIMIT.default;
  let statement = attempts(db)
    .where('a.workspace_id', '=', context.workspaceId)
    .where('a.recipient_id', '=', recipientId)
    .orderBy('a.id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) statement = statement.where('a.id', '<', query.before);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => delivery(row, clock.now())),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};

/** Internal proof from the authenticated invitation journey, never an arbitrary email-directory lookup. */
export const recordInvitationApplicant = async (
  db: Executor,
  clock: Clock,
  userId: string,
  invitationId: string,
  joined = false,
): Promise<void> => {
  const user = await db
    .selectFrom('users')
    .select(['email', 'email_verified', 'deleted_at'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user === undefined || !user.email_verified || user.deleted_at !== null) return;
  const address = normalisedMailbox(user.email);
  if (address === undefined) return;
  await db
    .updateTable('workspace_invitation_recipients')
    .set({
      applicant_user_id: userId,
      ...(joined ? { joined_at: clock.now() } : { requested_at: clock.now() }),
    })
    .where('email', '=', address)
    .where(
      'id',
      'in',
      db
        .selectFrom('workspace_invitation_mail_attempts')
        .select('recipient_id')
        .where('invitation_id', '=', invitationId),
    )
    .where(joined ? 'joined_at' : 'requested_at', 'is', null)
    .execute();
};
