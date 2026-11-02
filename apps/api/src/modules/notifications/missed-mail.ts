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
 * - **Only what they can still read**, decided when the letter is written: a workspace they are in, a channel
 *   the one visibility rule shows them (`visibleChannelIds`, D-34), a message not deleted. Anything else is
 *   passed over for good (`mailed_at` set, no letter), so it never holds a place in the next run's batch.
 *   An erased or suspended account, or one whose address was never verified, is never mailed.
 * - **Never twice, whatever runs at once.** Each person is taken in a transaction of their own, under their
 *   row's lock taken with `SKIP LOCKED`: a second run passes over a person the first holds. The hour between
 *   two letters and `mailed_at IS NULL` are read under that lock, and the rows are marked before the commit.
 *   The letter is sent after the commit; if the relay refuses it, its rows are given back for the next run,
 *   and the run fails so `jobs:status` says so. A process that dies between the commit and the send loses that
 *   one letter rather than sending it twice.
 * - **The link that stops it** opens without a session: a random token, whose digest alone is kept with the
 *   letter (`platform/tokens.ts`), good for `STOP_LINK_DAYS`. The job forgets letters past that.
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import {
  type MissedMailSetting,
  type NotificationType,
  type SetMissedMailRequest,
  type StopMissedMailRequest,
} from '@purlay/types';
import { DAY_MS, HOUR_MS, type Clock } from '../../platform/clock';
import { visibleChannelIds } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { codeOf, type MailMessage, type SendMail } from '../../platform/mail';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { atomicallyOn } from '../../platform/transactions';
import { inDeepWork } from '../workspaces/deep-work';
import { missedLetter, type MissedConversation, type MissedWorkspace } from './missed-mail-letter';

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
const MISSED_MAIL_TYPES = [
  'mention',
  'direct_message',
] as const satisfies readonly NotificationType[];
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
  executor: Executor,
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
  executor: Executor,
  userId: string,
  mailOn: boolean,
): Promise<MissedMailSetting> => await availableTo(executor, userId, mailOn);

/**
 * Turns it on — from now: what they were told before is never mailed — or off. On again while on keeps the
 * instant it was first turned on. On is refused where it could not be honoured.
 */
export const setMissedMail = async (
  executor: Executor,
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
  executor: Executor,
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
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  /** The relay; absent where the server has none, and then nothing is mailed. */
  readonly send: SendMail | undefined;
  readonly appUrl: string;
}

/** A letter written and its rows marked, committed, waiting to be sent. */
interface Taken {
  readonly letterId: string;
  readonly notificationIds: readonly string[];
  readonly letter: MailMessage;
}

/** The person's context in a workspace, or null where they are no longer in it. */
const memberOf = async (
  transaction: Transaction,
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
  transaction: Transaction,
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
  transaction: Transaction,
  messageIds: readonly string[],
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
  transaction: Transaction,
  now: Date,
  userId: string,
  appUrl: string,
): Promise<Taken | null> => {
  const person = await transaction
    .selectFrom('users')
    .select(['email', 'locale', 'missed_mail_since'])
    .where('id', '=', userId)
    .where('missed_mail_since', 'is not', null)
    .where('deleted_at', 'is', null)
    .where('suspended_at', 'is', null)
    .where('email_verified', '=', true)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (person?.missed_mail_since == null) return null;
  const recent = await transaction
    .selectFrom('missed_mail_letters')
    .select('id')
    .where('user_id', '=', userId)
    .where('sent_at', '>', new Date(now.getTime() - MISSED_MAIL_WINDOW_MS))
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
  const quoted = await messagesOf(transaction, [...new Set(readable.map((row) => row.message_id))]);
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
  return {
    letterId: letter.id,
    notificationIds: mailed.map((row) => row.id),
    letter: missedLetter({
      to: person.email,
      locale: person.locale === 'tr' ? 'tr' : 'en',
      appUrl,
      stopToken: token,
      workspaces: shape(quoted.filter((row) => messageIds.has(row.id))),
    }),
  };
};

/** A letter the relay did not take: its rows wait for the next run, and its hour is not spent. */
const giveBack = async (transaction: Transaction, taken: Taken): Promise<void> => {
  await transaction
    .updateTable('notifications')
    .set({ mailed_at: null })
    .where('id', 'in', taken.notificationIds)
    .execute();
  await transaction.deleteFrom('missed_mail_letters').where('id', '=', taken.letterId).execute();
};

/** `mail:missed`: every letter due now, and the letters past their stop link forgotten. */
export const mailMissedMessages = async (
  dependencies: MissedMailDependencies,
): Promise<{ letters: number; failed: number; forgotten: number }> => {
  const { database, clock, log, send, appUrl } = dependencies;
  const now = clock.now();
  const forgotten = await database
    .deleteFrom('missed_mail_letters')
    .where('sent_at', '<=', new Date(now.getTime() - STOP_LINK_DAYS * DAY_MS))
    .executeTakeFirst();
  const outcome = { letters: 0, failed: 0, forgotten: Number(forgotten.numDeletedRows) };
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
      async (transaction) => await takeLetter(transaction, now, id, appUrl),
    );
    if (taken === null) continue;
    try {
      await send(taken.letter);
      outcome.letters += 1;
    } catch (error) {
      outcome.failed += 1;
      // The relay's code only: its words can quote the recipient back (ARCHITECTURE §10).
      log.error('a missed-mail letter could not be sent', { reason: codeOf(error) });
      await atomicallyOn(database)(async (transaction) => {
        await giveBack(transaction, taken);
      });
    }
  }
  if (outcome.failed > 0) {
    throw new Error(
      `${String(outcome.failed)} missed-mail letter(s) were refused by the mail relay, and will be tried again`,
    );
  }
  return outcome;
};
