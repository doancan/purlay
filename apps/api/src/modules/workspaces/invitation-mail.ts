/**
 * Invitation email (D-279, extending D-179 §5): a separate bearer link per recipient and a
 * separate copy link in the create response. Each recipient can be followed up or revoked independently.
 * All links still admit their signed-in holder as a member; no address or role is bound to them.
 *
 * - **The server is not a mail relay.** At most twenty addresses a request (the contract's `400`),
 *   repeats of an address in any case dropped before they are counted, fifty letters a day for an
 *   inviter and two hundred for a workspace — counted in the database (`platform/quota.ts`), so a
 *   restart hands nothing back — and only an owner or an admin, which `createInvitation` judges first,
 *   before an address is looked at.
 * - **Said honestly.** What the answer can say of an address is *queued*: the letter is handed to the
 *   mail server after the answer (`afterAnswer` and the outbox), so nothing has been delivered, nor even
 *   accepted, when the inviter reads it. Its later receipt is kept as a safe category in private
 *   recipient history. Relay acceptance is never called inbox delivery.
 * - **No look at who is in.** Whether an address already belongs to a member is not answered: members'
 *   addresses are never shown to each other (`models.ts`), and an answer for an address typed would
 *   say it. Mailing a member is harmless — joining again changes nothing (D-115 §3).
 * - **Nothing typed reaches a header.** The subject is fixed text; the inviter's and the workspace's
 *   names, which are other people's, appear only in the body, stripped of line breaks and control
 *   characters, cut short, and with anything that reads as a web address broken.
 */
import type { Transaction } from '@purlay/db';
import {
  INVITATION_EMAILS_PER_INVITER_PER_DAY,
  INVITATION_EMAILS_PER_WORKSPACE_PER_DAY,
  normalisedMailbox,
  messageId,
  type CreateInvitationRequest,
  type CreatedInvitation,
  type InvitationMailResult,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { composeLetter } from '../../platform/letter';
import type { MailMessage } from '../../platform/mail';
import { takeDaily, type Allowance } from '../../platform/quota';
import type { WorkspaceContext } from '../../platform/tenancy';
import { createInvitation, revokeInvitation, notFound } from './invitations';
import { addInvitationAttempt, INVITATION_RECEIPT_WAIT_MS } from './invitation-delivery';
import { requireInvitationManagerNow } from './invitation-manager';
import { AppError } from '../../platform/errors';

type Locale = NonNullable<CreateInvitationRequest['locale']>;

/** The longest a name is quoted: what is left is a hint, the workspace's page has the rest. */
const NAME_MAX = 60;

/**
 * Somebody else's words, made safe to quote in a letter: no line break to start a line of one's own,
 * no control or invisible character (a right-to-left override reorders what follows it), one space
 * between words, at most `max` characters (`NAME_MAX` for a name), and no `://` for a mail client to
 * make a link of. Nothing left is `fallback`.
 */
export const quotable = (name: string, fallback: string, max = NAME_MAX): string => {
  const plain = name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/:\/\//g, ': ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return fallback;
  const letters = Array.from(plain);
  return letters.length <= max
    ? plain
    : `${letters
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
};

const WORDS = {
  en: {
    subject: 'You have been invited to Purlay',
    someone: 'Someone',
    workspace: 'a workspace',
    invited: (inviter: string, workspace: string): string =>
      `${inviter} invited you to join “${workspace}” on Purlay.`,
    button: 'Accept the invitation',
    until: (until: string): string =>
      `The link works until ${until} for anybody who has it, so keep it to yourself.`,
    ignore:
      'If you did not expect this, you can ignore it; nothing happens until somebody opens the link.',
  },
  tr: {
    subject: 'Purlay’a davet edildin',
    someone: 'Biri',
    workspace: 'bir çalışma alanı',
    invited: (inviter: string, workspace: string): string =>
      `${inviter} seni Purlay’da “${workspace}” alanına katılmaya davet etti.`,
    button: 'Daveti kabul et',
    until: (until: string): string =>
      `Bağlantı ${until} tarihine kadar, elinde olan herkes için çalışır; kimseyle paylaşma.`,
    ignore: 'Beklemiyorsan görmezden gelebilirsin; biri bağlantıyı açmadıkça hiçbir şey olmaz.',
  },
} as const;

const untilWords = (expiresAt: string, locale: Locale): string =>
  `${new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(expiresAt))} UTC`;

export interface Letterhead {
  readonly inviter: string;
  readonly workspace: string;
  readonly expiresAt: string;
  /** `APP_URL/invite#<token>`: the token in the fragment, which no request line writes (D-115). */
  readonly url: string;
  readonly locale: Locale;
}

/** The letter to one address: who invited, to what, the link, until when, and that it may be ignored. */
export const invitationLetter = (to: string, head: Letterhead): MailMessage => {
  const words = WORDS[head.locale];
  return composeLetter({
    to,
    subject: words.subject,
    locale: head.locale,
    blocks: [
      {
        kind: 'paragraph',
        text: words.invited(
          quotable(head.inviter, words.someone),
          quotable(head.workspace, words.workspace),
        ),
      },
      { kind: 'button', label: words.button, url: head.url },
      { kind: 'note', text: words.until(untilWords(head.expiresAt, head.locale)) },
      { kind: 'note', text: words.ignore },
    ],
  });
};

/** The counter of an inviter's letters, which an erasure deletes with the rest of the person. */
export const inviterMailKey = (userId: string): string => `purlay:invite-mail:inviter:${userId}`;

export interface InvitationLetter extends MailMessage {
  readonly attemptId: string;
}

export interface MailedInvitation {
  readonly created: CreatedInvitation;
  /** The letters to hand to the mail server once the answer is on its way — and the transaction committed. */
  readonly letters: readonly InvitationLetter[];
}

/**
 * The addresses as they will be counted: each valid one once, in the order first typed, as it is
 * stored; an invalid one answered once, as typed.
 */
const distinct = (
  typed: readonly string[],
): { readonly valid: string[]; readonly entries: { address: string; valid: boolean }[] } => {
  const seen = new Set<string>();
  const valid: string[] = [];
  const entries: { address: string; valid: boolean }[] = [];
  for (const raw of typed) {
    const address = normalisedMailbox(raw);
    const key = address ?? raw.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (address === undefined) entries.push({ address: raw.trim(), valid: false });
    else {
      entries.push({ address, valid: true });
      valid.push(address);
    }
  }
  return { valid, entries };
};

/**
 * `POST …/invitations` — a new link (`createInvitation`, audited as always), and, when addresses came
 * with it, which of them the letter is queued for. `mailOn` is whether this server has a relay.
 * Everything here is in the caller's transaction: a request that fails gives back what it took.
 */
export const makeAndMailInvitation = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  request: CreateInvitationRequest,
  mail: { readonly on: boolean; readonly appUrl: string },
): Promise<MailedInvitation> => {
  const created = await createInvitation(transaction, clock, context);
  const typed = request.emails ?? [];
  if (typed.length === 0) return { created, letters: [] };

  const { valid, entries } = distinct(typed);
  const outcomeOf = new Map<string, InvitationMailResult['outcome']>();
  let queued: string[] = [];
  if (!mail.on) {
    for (const address of valid) outcomeOf.set(address, 'unavailable');
  } else if (valid.length > 0) {
    const { taken, inviter } = await reserveMail(transaction, clock, context, valid.length);
    queued = valid.slice(0, taken.granted);
    const refusal = taken.refusedBy === inviter ? 'inviter_limit' : 'workspace_limit';
    valid.forEach((address, index) => {
      outcomeOf.set(address, index < taken.granted ? 'queued' : refusal);
    });
  }
  const mailed: CreatedInvitation = {
    ...created,
    mail: entries.map(({ address, valid: ok }) => ({
      address,
      outcome: ok ? (outcomeOf.get(address) ?? 'unavailable') : 'invalid',
    })),
  };
  if (queued.length === 0) return { created: mailed, letters: [] };

  // Read here, in the same transaction, so a letter says what was true when the link was made.
  const names = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select(['users.display_name', 'workspaces.name'])
    .where('workspace_members.workspace_id', '=', context.workspaceId)
    .where('workspace_members.user_id', '=', context.userId)
    .executeTakeFirst();
  const head = {
    inviter: names?.display_name ?? '',
    workspace: names?.name ?? '',
    expiresAt: created.invitation.expiresAt,
    url: `${mail.appUrl}/invite#${created.token}`,
    locale: request.locale ?? ('en' as const),
  };
  const letters: InvitationLetter[] = [];
  for (const address of queued) {
    const recipientId = messageId(clock.now());
    await transaction
      .insertInto('workspace_invitation_recipients')
      .values({
        id: recipientId,
        workspace_id: context.workspaceId,
        email: address,
        locale: head.locale,
        created_by: context.userId,
        created_at: clock.now(),
      })
      .execute();
    const personal = await createInvitation(transaction, clock, context);
    const attemptId = await addInvitationAttempt(
      transaction,
      clock,
      context.workspaceId,
      recipientId,
      personal.invitation.id,
    );
    letters.push({
      ...invitationLetter(address, {
        ...head,
        expiresAt: personal.invitation.expiresAt,
        url: `${mail.appUrl}/invite#${personal.token}`,
      }),
      attemptId,
    });
  }
  return { created: mailed, letters };
};

/** Both first send and resend spend the same durable quotas. */
const reserveMail = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  count: number,
): Promise<{
  readonly taken: Awaited<ReturnType<typeof takeDaily>>;
  readonly inviter: Allowance;
}> => {
  const inviter: Allowance = {
    key: inviterMailKey(context.userId),
    limit: INVITATION_EMAILS_PER_INVITER_PER_DAY,
  };
  const workspace: Allowance = {
    key: `purlay:invite-mail:workspace:${context.workspaceId}`,
    limit: INVITATION_EMAILS_PER_WORKSPACE_PER_DAY,
  };
  return { taken: await takeDaily(transaction, clock.now(), [inviter, workspace], count), inviter };
};

/** Serialised per recipient. Old links are revoked only after a replacement can be queued. */
export const resendInvitationRecipient = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  recipientId: string,
  mail: { readonly on: boolean; readonly appUrl: string },
): Promise<InvitationLetter> => {
  await requireInvitationManagerNow(transaction, context);
  const recipient = await transaction
    .selectFrom('workspace_invitation_recipients')
    .selectAll()
    .where('workspace_id', '=', context.workspaceId)
    .where('id', '=', recipientId)
    .executeTakeFirst();
  if (recipient === undefined) throw notFound();
  if (!mail.on)
    throw new AppError({
      code: 'EMAIL_SIGN_IN_UNAVAILABLE',
      message: 'Configure the mail relay before sending invitations.',
    });
  const previous = await transaction
    .selectFrom('workspace_invitation_mail_attempts')
    .selectAll()
    .where('workspace_id', '=', context.workspaceId)
    .where('recipient_id', '=', recipientId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  await transaction
    .selectFrom('workspace_invitations')
    .select('id')
    .where('id', '=', previous.invitation_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const latest = await transaction
    .selectFrom('workspace_invitation_mail_attempts')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .where('recipient_id', '=', recipientId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  if (latest.id !== previous.id)
    throw new AppError(
      { code: 'RATE_LIMITED', message: 'This invitation changed. Refresh before trying again.' },
      { retryAfterSeconds: 1 },
    );
  if (
    previous.result === 'queued' &&
    clock.now().getTime() - new Date(previous.created_at).getTime() < INVITATION_RECEIPT_WAIT_MS
  )
    throw new AppError(
      {
        code: 'RATE_LIMITED',
        message: 'This invitation is still being sent. Wait before trying again.',
      },
      { retryAfterSeconds: 120 },
    );
  const { taken } = await reserveMail(transaction, clock, context, 1);
  if (taken.granted === 0)
    throw new AppError(
      { code: 'RATE_LIMITED', message: 'The daily invitation mail limit has been reached.' },
      { retryAfterSeconds: 86_400 },
    );
  await revokeInvitation(transaction, clock, context, previous.invitation_id);
  const made = await createInvitation(transaction, clock, context);
  const attemptId = await addInvitationAttempt(
    transaction,
    clock,
    context.workspaceId,
    recipientId,
    made.invitation.id,
    previous.id,
  );
  const names = await transaction
    .selectFrom('users')
    .innerJoin('workspaces', (join) => join.on('workspaces.id', '=', context.workspaceId))
    .select(['users.display_name', 'workspaces.name'])
    .where('users.id', '=', context.userId)
    .executeTakeFirstOrThrow();
  return {
    ...invitationLetter(recipient.email, {
      inviter: names.display_name,
      workspace: names.name,
      expiresAt: made.invitation.expiresAt,
      url: `${mail.appUrl}/invite#${made.token}`,
      locale: recipient.locale as Locale,
    }),
    attemptId,
  };
};

/** Every older attempt was already revoked by resend; the newest is the only remaining open link. */
export const revokeInvitationRecipient = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  recipientId: string,
): Promise<void> => {
  await requireInvitationManagerNow(transaction, context);
  const recipient = await transaction
    .selectFrom('workspace_invitation_recipients')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .where('id', '=', recipientId)
    .executeTakeFirst();
  if (recipient === undefined) throw notFound();
  const last = await transaction
    .selectFrom('workspace_invitation_mail_attempts')
    .select('invitation_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('recipient_id', '=', recipientId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  await transaction
    .selectFrom('workspace_invitations')
    .select('id')
    .where('id', '=', last.invitation_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const current = await transaction
    .selectFrom('workspace_invitation_mail_attempts')
    .select('invitation_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('recipient_id', '=', recipientId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  if (current.invitation_id !== last.invitation_id)
    throw new AppError(
      { code: 'RATE_LIMITED', message: 'This invitation changed. Refresh before trying again.' },
      { retryAfterSeconds: 1 },
    );
  await revokeInvitation(transaction, clock, context, last.invitation_id);
};
