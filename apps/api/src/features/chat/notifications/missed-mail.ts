/**
 * Email about what a person missed (D-240): off until they turn it on, and then one letter, at most one an
 * hour, about the mentions and direct messages that waited unread for them past `MISSED_MAIL_DELAY_MS`.
 *
 * - **Only what they asked for.** A mention or a direct message (`MISSED_MAIL_TYPES`), told since the setting
 *   was turned on, still unread, never mailed before. A thread reply and a channel set to every message are
 *   left to the inbox and push: the setting says "direct messages and mentions", and a letter is a heavier
 *   interruption than a notice.
 * - **Quiet is kept.** A workspace in which the person is in Deep Work, or every workspace in their quiet
 *   hours (`inDeepWork`, D-15, D-234), is held: nothing of it is mailed now, and it is mailed after, if it is
 *   still unread then — nothing is lost and nothing interrupts.
 * - **Only what they can still read**, checked at composition and again before relay handoff: a workspace they
 *   are in, a channel the canonical guard shows them, and a live message inside their guest history. Anything else is
 *   passed over for good (`mailed_at` set, no letter), so it never holds a place in the next run's batch.
 *   An erased or suspended account, or one whose address was never verified, is never mailed.
 *   A changed address, opt-out, read, revoked scope or quiet period after composition returns the claim without
 *   spending its hourly slot; a later run rebuilds a smaller current letter.
 * - **At least once, and a repeat is recognisable (D-297).** Each person is taken in a transaction of their own,
 *   under their row's lock taken with `SKIP LOCKED`: a second run passes over a person the first holds. The
 *   hour between two letters and `mailed_at IS NULL` are read under that lock, and the rows are marked before
 *   the commit, so two runs at once never send one letter twice. The letter is sent after the commit; if the
 *   relay does not take it, its rows are given back for the next run and the run fails so `jobs:status` says
 *   so. A failure after the relay has the letter (a timeout waiting for its answer) cannot be told from one
 *   before, so that letter can arrive twice; both carry the same `Message-ID`, made from the rows it is about.
 *   A relay that says this address does not exist (an addressing status, `5.1.x`) is not tried again.
 *   A five-minute durable claim recovers after process death (D-302); a late old worker cannot settle its replacement.
 * - **The link that stops it** opens without a session: a random token, whose digest alone is kept with the
 *   letter (`platform/tokens.ts`), good for `STOP_LINK_DAYS`. The job forgets letters past that.
 */
import { sql, type Selectable, type SelectQueryBuilder } from '@purlay/db';
import type { ChatDb, ChatSchema, ChatTx } from '../schema';
import {
  CHAT_NOTIFICATION_KINDS,
  type MissedMailSetting,
  type NotificationType,
  type SetMissedMailRequest,
  type StopMissedMailRequest,
} from '@purlay/types';
import { DAY_MS, HOUR_MS, type Clock } from '../../../platform/clock';
import { channelAudienceQuery, visibleChannelIds } from '../channels/guard';
import { AppError } from '../../../platform/errors';
import type { Logger } from '../../../platform/logging';
import { codeOf, type MailMessage, type SendMail } from '../../../platform/mail';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import { randomToken, tokenDigest } from '../../../platform/tokens';
import { atomicallyOn } from '../../../platform/transactions';
import { inDeepWork } from '../../../modules/workspaces/deep-work';
import { missedLetter, type MissedConversation, type MissedWorkspace } from './missed-mail-letter';
import {
  MISSED_MAIL_CLAIM_MS,
  recoverMailClaims,
  releaseMailClaim,
  settleMailClaim,
} from './missed-mail-claims';

/**
 * How long a notification waits unread before it is mailed: long enough that a person at their desk, or
 * one a push already reached, has read it — a mail about what they read a minute ago is noise — and short
 * enough that a direct message is not a morning's news. The scheduler runs the job every quarter hour, so a
 * letter leaves between fifteen and thirty minutes after the message.
 */
export const MISSED_MAIL_DELAY_MS = 15 * 60 * 1000;
/** At most one letter an hour for a person: what waits in between goes in the next. */
const MISSED_MAIL_WINDOW_MS = HOUR_MS;
/** How long a letter's stop link opens, and its row is kept. */
export const STOP_LINK_DAYS = 30;
/** The reasons a letter is about: what the setting names. */
const MISSED_MAIL_TYPES: readonly NotificationType[] = CHAT_NOTIFICATION_KINDS.filter(
  (kind) => kind.mailed,
).map((kind) => kind.type);
/** Notifications one letter takes at most; more wait for the next. */
const BATCH_MAX = 200;

const refusedOn = (): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'This server cannot send you email.',
    details: { fields: { on: 'needs a mail server and a verified address' } },
  });

/** Whether the person can be mailed at all: the server has a relay, and their address was proven. */
const availableTo = async (
  executor: ChatDb,
  userId: string,
  mailOn: boolean,
): Promise<{ readonly available: boolean; readonly on: boolean }> => {
  const row = await executor
    .selectFrom('users')
    .select(['email_verified', 'missed_mail_since'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return { available: mailOn && row.email_verified, on: row.missed_mail_since !== null };
};

export const readMissedMail = async (
  executor: ChatDb,
  userId: string,
  mailOn: boolean,
): Promise<MissedMailSetting> => await availableTo(executor, userId, mailOn);

/**
 * Turns it on — from now: what they were told before is never mailed — or off. On again while on keeps the
 * instant it was first turned on. On is refused where it could not be honoured.
 */
export const setMissedMail = async (
  executor: ChatDb,
  clock: Clock,
  userId: string,
  input: SetMissedMailRequest,
  mailOn: boolean,
): Promise<MissedMailSetting> => {
  const { available } = await availableTo(executor, userId, mailOn);
  if (input.on && !available) throw refusedOn();
  const row = await executor
    .updateTable('users')
    .set({
      missed_mail_since: input.on ? sql<Date>`coalesce(missed_mail_since, ${clock.now()})` : null,
    })
    .where('id', '=', userId)
    .returning('missed_mail_since')
    .executeTakeFirstOrThrow();
  return { available, on: row.missed_mail_since !== null };
};

const linkRefused = (): AppError =>
  new AppError({ code: 'MAIL_LINK_NOT_FOUND', message: 'This link does not open.' });

/**
 * A letter's stop link: turns the setting off for the person it was sent to, whoever opens it, and nobody
 * else. Again is the same answer; a link nobody made, or one past `STOP_LINK_DAYS`, is one refusal.
 */
export const stopMissedMail = async (
  executor: ChatDb,
  clock: Clock,
  input: StopMissedMailRequest,
): Promise<void> => {
  const letter = await executor
    .selectFrom('missed_mail_letters')
    .select('user_id')
    .where('stop_digest', '=', await tokenDigest(input.token))
    .where('sent_at', '>', new Date(clock.now().getTime() - STOP_LINK_DAYS * DAY_MS))
    .executeTakeFirst();
  if (letter === undefined) throw linkRefused();
  await executor
    .updateTable('users')
    .set({ missed_mail_since: null })
    .where('id', '=', letter.user_id)
    .execute();
};

export interface MissedMailDependencies {
  readonly database: ChatDb;
  readonly clock: Clock;
  readonly log: Logger;
  /** The relay; absent where the server has none, and then nothing is mailed. */
  readonly send: SendMail | undefined;
  readonly appUrl: string;
}

/** A letter written and its rows marked, committed, waiting to be sent. */
interface Taken {
  readonly userId: string;
  readonly letterId: string;
  readonly notificationIds: readonly string[];
  readonly letter: MailMessage;
}

/** The same account eligibility at claim and handoff; only the claim takes its row lock. */
const mailablePerson = (
  transaction: ChatTx,
  userId: string,
): SelectQueryBuilder<
  ChatSchema,
  'users',
  Pick<Selectable<ChatSchema['users']>, 'email' | 'locale' | 'missed_mail_since'>
> =>
  transaction
    .selectFrom('users')
    .select(['email', 'locale', 'missed_mail_since'])
    .where('id', '=', userId)
    .where('missed_mail_since', 'is not', null)
    .where('deleted_at', 'is', null)
    .where('suspended_at', 'is', null)
    .where('email_verified', '=', true);

/** The person's context in a workspace, or null where they are no longer in it. */
const memberOf = async (
  transaction: ChatTx,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext | null> => {
  try {
    return await requireWorkspaceMembership(transaction, userId, workspaceId);
  } catch (error) {
    if (error instanceof AppError && error.body.code === 'WORKSPACE_NOT_FOUND') return null;
    throw error;
  }
};

/** What each workspace of these rows is for the person now: held, gone, or the channels they can see. */
const standing = async (
  transaction: ChatTx,
  userId: string,
  workspaceIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, 'held' | ReadonlySet<string>>> => {
  const result = new Map<string, 'held' | ReadonlySet<string>>();
  for (const workspaceId of workspaceIds) {
    const context = await memberOf(transaction, userId, workspaceId);
    if (context === null) {
      result.set(workspaceId, new Set());
    } else if ((await inDeepWork(transaction, workspaceId, [userId], now)).has(userId)) {
      result.set(workspaceId, 'held');
    } else {
      result.set(workspaceId, new Set(await visibleChannelIds(transaction, context)));
    }
  }
  return result;
};

/** The messages a letter quotes, with where they are: one statement for the whole letter. */
const messagesOf = async (
  transaction: ChatTx,
  messageIds: readonly string[],
  userId: string,
): Promise<
  readonly {
    readonly id: string;
    readonly content: string;
    readonly author: string | null;
    readonly channel_id: string;
    readonly channel_name: string | null;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly slug: string;
  }[]
> =>
  messageIds.length === 0
    ? []
    : await transaction
        .selectFrom('messages as m')
        .innerJoin('channels as c', 'c.id', 'm.channel_id')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .leftJoin('users as a', 'a.id', 'm.sender_id')
        .select([
          'm.id',
          'm.content',
          'a.display_name as author',
          'm.channel_id',
          'c.name as channel_name',
          'm.workspace_id',
          'w.name as workspace_name',
          'w.slug',
        ])
        .where('m.id', 'in', messageIds)
        .where('m.deleted_at', 'is', null)
        .where((eb) =>
          eb.exists(
            channelAudienceQuery(
              transaction,
              sql.ref<string>('m.channel_id'),
              sql.ref<string>('m.id'),
            ).where('users.id', '=', userId),
          ),
        )
        .orderBy('m.id')
        .execute();

/** The letter's workspaces, by name; their conversations, the newest first; each one's messages, oldest first. */
const shape = (rows: Awaited<ReturnType<typeof messagesOf>>): MissedWorkspace[] => {
  const workspaces = new Map<
    string,
    { name: string; slug: string; conversations: Map<string, MissedConversation> }
  >();
  for (const row of rows) {
    const workspace = workspaces.get(row.workspace_id) ?? {
      name: row.workspace_name,
      slug: row.slug,
      conversations: new Map<string, MissedConversation>(),
    };
    workspaces.set(row.workspace_id, workspace);
    const conversation = workspace.conversations.get(row.channel_id) ?? {
      channelId: row.channel_id,
      name: row.channel_name,
      messages: [],
    };
    workspace.conversations.set(row.channel_id, {
      ...conversation,
      messages: [
        ...conversation.messages,
        { id: row.id, author: row.author, content: row.content },
      ],
    });
  }
  const newest = (conversation: MissedConversation): string =>
    conversation.messages.at(-1)?.id ?? '';
  return [...workspaces.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((workspace) => ({
      name: workspace.name,
      slug: workspace.slug,
      conversations: [...workspace.conversations.values()].sort((a, b) =>
        newest(b).localeCompare(newest(a)),
      ),
    }));
};

/**
 * One person's letter, in their own transaction: their row locked or passed over, the hour checked, what can
 * be mailed chosen and marked, what never can be passed over, and the letter's row written. Null where there
 * is nothing to send now.
 */
const takeLetter = async (
  transaction: ChatTx,
  now: Date,
  userId: string,
  appUrl: string,
): Promise<Taken | null> => {
  const person = await mailablePerson(transaction, userId)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (person?.missed_mail_since == null) return null;
  const active = await transaction
    .selectFrom('missed_mail_claims as claim')
    .innerJoin('missed_mail_letters as letter', 'letter.id', 'claim.letter_id')
    .select('claim.letter_id')
    .where('letter.user_id', '=', userId)
    .where('claim.lease_until', 'is not', null)
    .executeTakeFirst();
  if (active !== undefined) return null;
  const recent = await transaction
    .selectFrom('missed_mail_letters')
    .select('id')
    .where('user_id', '=', userId)
    .where('sent_at', '>', new Date(now.getTime() - MISSED_MAIL_WINDOW_MS))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('missed_mail_claims as claim')
            .select('claim.letter_id')
            .whereRef('claim.letter_id', '=', 'missed_mail_letters.id'),
        ),
      ),
    )
    .executeTakeFirst();
  if (recent !== undefined) return null;

  const pending = await transaction
    .selectFrom('notifications')
    .select(['id', 'workspace_id', 'channel_id', 'message_id'])
    .where('user_id', '=', userId)
    .where('read_at', 'is', null)
    .where('mailed_at', 'is', null)
    .where('type', 'in', MISSED_MAIL_TYPES)
    .where('created_at', '>=', person.missed_mail_since)
    .where('created_at', '<=', new Date(now.getTime() - MISSED_MAIL_DELAY_MS))
    .orderBy('created_at')
    .orderBy('id')
    .limit(BATCH_MAX)
    .execute();
  const where = await standing(
    transaction,
    userId,
    [...new Set(pending.map((row) => row.workspace_id))],
    now,
  );
  const readable = pending.filter((row) => {
    const seen = where.get(row.workspace_id);
    return seen !== 'held' && seen?.has(row.channel_id) === true;
  });
  const quoted = await messagesOf(
    transaction,
    [...new Set(readable.map((row) => row.message_id))],
    userId,
  );
  const live = new Set(quoted.map((row) => row.id));
  const mailable = readable.filter((row) => live.has(row.message_id));
  // Settled now: what is mailed, and what never can be — a channel or a workspace no longer theirs, a
  // message gone. What a hold keeps waits for the next run.
  const settling = pending.filter((row) => where.get(row.workspace_id) !== 'held');
  if (settling.length === 0) return null;

  // The memberships first, in one order, as reading takes them (`notifications.ts`), then the rows: a read
  // at the same instant takes its turn instead of each holding what the other waits for.
  const channels = [...new Set(mailable.map((row) => row.channel_id))].sort();
  if (channels.length > 0) {
    await transaction
      .selectFrom('channel_members')
      .select('channel_id')
      .where('user_id', '=', userId)
      .where('channel_id', 'in', channels)
      .orderBy('channel_id')
      .forUpdate()
      .execute();
  }
  const marked = await transaction
    .updateTable('notifications')
    .set({ mailed_at: now })
    .where(
      'id',
      'in',
      settling.map((row) => row.id),
    )
    .where('mailed_at', 'is', null)
    // Read since it was chosen: nothing to tell.
    .where('read_at', 'is', null)
    .returning('id')
    .execute();
  const markedIds = new Set(marked.map((row) => row.id));
  const mailed = mailable.filter((row) => markedIds.has(row.id));
  if (mailed.length === 0) return null;

  const messageIds = new Set(mailed.map((row) => row.message_id));
  const token = randomToken();
  const letter = await transaction
    .insertInto('missed_mail_letters')
    .values({ user_id: userId, sent_at: now, stop_digest: await tokenDigest(token) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto('missed_mail_claims')
    .values({
      letter_id: letter.id,
      notification_ids: mailed.map((row) => row.id),
      lease_until: new Date(now.getTime() + MISSED_MAIL_CLAIM_MS),
    })
    .execute();
  return {
    userId,
    letterId: letter.id,
    notificationIds: mailed.map((row) => row.id),
    letter: {
      ...missedLetter({
        to: person.email,
        locale: person.locale === 'tr' ? 'tr' : 'en',
        appUrl,
        stopToken: token,
        workspaces: shape(quoted.filter((row) => messageIds.has(row.id))),
      }),
      messageId: await messageIdFor(
        mailed.map((row) => row.id),
        appUrl,
      ),
    },
  };
};

/**
 * Whether the relay said that this address, and not the relay, is the trouble: a permanent refusal (5xx)
 * carrying an addressing status (RFC 3463 `5.1.1` to `5.1.3`: no such mailbox, no such domain, a bad
 * address). A bare `550` is not enough, as `550 5.7.1 relaying denied` is the relay's own and would be said
 * to every person. A relay that sends no status is taken to be the trouble, and the letter is tried again.
 */
const addressRefusedForGood = (error: unknown): boolean => {
  const { responseCode, response } = (error ?? {}) as {
    responseCode?: unknown;
    response?: unknown;
  };
  return (
    typeof responseCode === 'number' &&
    responseCode >= 500 &&
    typeof response === 'string' &&
    /\b5\.1\.[123]\b/.test(response)
  );
};

/**
 * The letter's `Message-ID`: the same for the same rows, so that a letter sent again after a failure that may
 * have come after the relay took it reads as the copy it is. The host is the server's own.
 */
const messageIdFor = async (
  notificationIds: readonly string[],
  appUrl: string,
): Promise<string> => {
  const digest = await tokenDigest([...notificationIds].sort().join(','));
  return `<missed-${digest.slice(0, 32)}@${new URL(appUrl).hostname}>`;
};

/** A letter the relay did not take: its rows wait for the next run, and its hour is not spent. */
const giveBack = async (transaction: ChatTx, taken: Taken): Promise<void> => {
  await releaseMailClaim(transaction, taken.userId, taken.letterId);
};

/** The claim is no longer authority after its commit: recheck before handing content to the relay. */
const letterStillReadable = async (
  transaction: ChatTx,
  now: Date,
  taken: Taken,
): Promise<boolean> => {
  const claim = await transaction
    .selectFrom('missed_mail_claims')
    .select('letter_id')
    .where('letter_id', '=', taken.letterId)
    .where('lease_until', '>', now)
    .executeTakeFirst();
  if (claim === undefined) return false;
  const person = await mailablePerson(transaction, taken.userId).executeTakeFirst();
  if (person?.missed_mail_since == null || person.email !== taken.letter.to) return false;
  const pending = await transaction
    .selectFrom('notifications')
    .select(['id', 'workspace_id', 'channel_id', 'message_id'])
    .where('id', 'in', taken.notificationIds)
    .where('user_id', '=', taken.userId)
    .where('read_at', 'is', null)
    .where('type', 'in', MISSED_MAIL_TYPES)
    .where('created_at', '>=', person.missed_mail_since)
    .execute();
  if (pending.length !== taken.notificationIds.length) return false;
  const where = await standing(
    transaction,
    taken.userId,
    [...new Set(pending.map((row) => row.workspace_id))],
    now,
  );
  if (
    pending.some((row) => {
      const scope = where.get(row.workspace_id);
      return scope === 'held' || scope?.has(row.channel_id) !== true;
    })
  )
    return false;
  const ids = [...new Set(pending.map((row) => row.message_id))];
  return (await messagesOf(transaction, ids, taken.userId)).length === ids.length;
};

/** `mail:missed`: every letter due now, and the letters past their stop link forgotten. */
export const mailMissedMessages = async (
  dependencies: MissedMailDependencies,
): Promise<{ letters: number; failed: number; refused: number; forgotten: number }> => {
  const { database, clock, log, send, appUrl } = dependencies;
  const now = clock.now();
  const recovered = await recoverMailClaims(database, now);
  if (recovered > 0) log.info('expired missed-mail claims released', { recovered });
  const forgotten = await database
    .deleteFrom('missed_mail_letters')
    .where('sent_at', '<=', new Date(now.getTime() - STOP_LINK_DAYS * DAY_MS))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('missed_mail_claims as claim')
            .select('claim.letter_id')
            .whereRef('claim.letter_id', '=', 'missed_mail_letters.id')
            .where('claim.lease_until', 'is not', null),
        ),
      ),
    )
    .executeTakeFirst();
  const outcome = {
    letters: 0,
    failed: 0,
    refused: 0,
    forgotten: Number(forgotten.numDeletedRows),
  };
  // No relay: nothing is taken, so nothing is lost — a relay added later mails what is still unread.
  if (send === undefined) return outcome;

  // Who may have a letter due: opted in, and something of theirs waiting past the delay. Whether they may be
  // mailed at all is decided under their lock (`takeLetter`), once.
  const people = await database
    .selectFrom('users as u')
    .select('u.id')
    .where('u.missed_mail_since', 'is not', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('notifications as n')
          .select('n.id')
          .whereRef('n.user_id', '=', 'u.id')
          .where('n.read_at', 'is', null)
          .where('n.mailed_at', 'is', null)
          .where('n.type', 'in', MISSED_MAIL_TYPES)
          .whereRef('n.created_at', '>=', 'u.missed_mail_since')
          .where('n.created_at', '<=', new Date(now.getTime() - MISSED_MAIL_DELAY_MS)),
      ),
    )
    .orderBy('u.id')
    .execute();

  for (const { id } of people) {
    const taken = await atomicallyOn(database)(
      async (transaction) => await takeLetter(transaction, clock.now(), id, appUrl),
    );
    if (taken === null) continue;
    const ready = await atomicallyOn(database)(async (transaction) => {
      if (await letterStillReadable(transaction, clock.now(), taken)) return true;
      // No SMTP attempt and no hourly slot spent. A later run rebuilds a smaller, current letter.
      await giveBack(transaction, taken);
      return false;
    });
    if (!ready) continue;
    let refused = false;
    try {
      await send(taken.letter);
    } catch (error) {
      // The relay's code only: its words can quote the recipient back (ARCHITECTURE §10).
      if (addressRefusedForGood(error)) {
        // Its rows stay marked: the next run would be refused the same way, for ever.
        refused = true;
        log.warn('a missed-mail address was refused for good', { reason: codeOf(error) });
      } else {
        outcome.failed += 1;
        log.error('a missed-mail letter could not be sent', { reason: codeOf(error) });
        try {
          await atomicallyOn(database)(async (transaction) => {
            await giveBack(transaction, taken);
          });
        } catch (givingBack) {
          // The durable claim remains pending for recovery; everybody else's delivery goes on.
          log.error('a missed-mail letter could not be given back', { reason: codeOf(givingBack) });
        }
        continue;
      }
    }
    try {
      await atomicallyOn(database)(async (transaction) => {
        await settleMailClaim(transaction, taken.userId, taken.letterId);
      });
      if (refused) outcome.refused += 1;
      else outcome.letters += 1;
    } catch (error) {
      // Keep a durable pending claim if the relay answered but its acknowledgement could not commit.
      outcome.failed += 1;
      log.error('a missed-mail result could not be recorded', { reason: codeOf(error) });
    }
  }
  if (outcome.failed > 0) {
    throw new Error(
      `${String(outcome.failed)} missed-mail letter(s) could not be completed, and will be tried again`,
    );
  }
  return outcome;
};
