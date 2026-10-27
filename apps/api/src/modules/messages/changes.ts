/**
 * What happened to a channel's messages since a client last heard (D-194).
 *
 * The messages themselves, as they now stand, in the order the *server* changed them — `messages.changed_at`, which
 * a trigger stamps on every update and the column's default stamps on every insert — and never the order their ids
 * sort in: a message that arrives late has an old id, and an edit, a deletion or a reaction has no new one.
 *
 * A walk begins at a watermark the client holds (`since`, the `asOf` of an earlier walk) and runs in pages to the
 * clock the walk began at; that clock is carried in every cursor, so a client keeps one value however many pages it
 * took and a change made while it was reading is the next walk's, not a gap in this one. A walk begins
 * `CHANGES_OVERLAP_MS` behind the watermark: a write stamps its row before it commits, and a row stamped before a
 * watermark can be committed after the read that made it.
 */
import { sql, type Executor } from '@purlay/db';
import { CHANGES_OVERLAP_MS, PAGE_LIMIT, type ChangePage, type ChangesQuery } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { ChannelContext } from '../../platform/channels';
import { buildMessages, MESSAGE_COLUMNS } from './reader';

/** The database's own clock, to the millisecond a stamp is kept to. */
const serverNow = async (executor: Executor): Promise<Date> => {
  const { now } = await executor
    .selectNoFrom(sql<Date>`date_trunc('milliseconds', clock_timestamp())`.as('now'))
    .executeTakeFirstOrThrow();
  return now;
};

const refused = (field: string, why: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The request did not match the contract.',
    details: { fields: { [field]: why } },
  });

interface Cursor {
  readonly changedAt: Date;
  readonly messageId: string;
  readonly asOf: Date;
}

/** `<changed_at ms>.<message id>.<asOf ms>`: made only here, and read only here. */
const written = ({ changedAt, messageId, asOf }: Cursor): string =>
  `${String(changedAt.getTime())}.${messageId}.${String(asOf.getTime())}`;

const read = (text: string): Cursor => {
  const [changedAt, messageId, asOf] = text.split('.');
  if (changedAt === undefined || messageId === undefined || asOf === undefined) {
    throw refused('after', 'is not a cursor this server made');
  }
  return {
    changedAt: new Date(Number(changedAt)),
    messageId,
    asOf: new Date(Number(asOf)),
  };
};

export const changesIn = async (
  executor: Executor,
  context: ChannelContext,
  query: ChangesQuery,
): Promise<ChangePage> => {
  if (query.since !== undefined && query.after !== undefined) {
    throw refused('after', 'cannot be combined with `since`');
  }
  const limit = Math.min(Math.max(query.limit ?? PAGE_LIMIT.default, 1), PAGE_LIMIT.max);

  // Only the watermark: where this server's clock is, for a client with nothing to ask since.
  if (query.since === undefined && query.after === undefined) {
    return { data: [], nextCursor: null, asOf: (await serverNow(executor)).toISOString() };
  }

  const cursor = query.after === undefined ? undefined : read(query.after);
  const since = query.since === undefined ? undefined : new Date(query.since);
  if (since !== undefined && Number.isNaN(since.getTime())) {
    throw refused('since', 'is not a time');
  }
  const now = await serverNow(executor);
  // A cursor is made here and is never later than the clock that made it: one that says otherwise would hand a
  // client a watermark this server never held, and the client would keep it and be told nothing for ever after.
  if (cursor !== undefined && (cursor.asOf > now || cursor.changedAt > cursor.asOf)) {
    throw refused('after', 'is not a cursor this server made');
  }
  const asOf = cursor?.asOf ?? now;

  let statement = executor
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select([...MESSAGE_COLUMNS, 'messages.changed_at'])
    .where('messages.channel_id', '=', context.channelId)
    .where('messages.changed_at', '<=', asOf)
    .orderBy('messages.changed_at', 'asc')
    .orderBy('messages.id', 'asc')
    // One more than asked for: whether another page exists is answered by reading, not by a COUNT.
    .limit(limit + 1);

  if (cursor !== undefined) {
    statement = statement.where(
      sql<boolean>`(messages.changed_at, messages.id) > (${cursor.changedAt}, ${cursor.messageId}::uuid)`,
    );
  } else if (since !== undefined) {
    statement = statement.where(
      'messages.changed_at',
      '>',
      new Date(since.getTime() - CHANGES_OVERLAP_MS),
    );
  }

  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: await buildMessages(executor, page),
    nextCursor:
      rows.length > limit && last !== undefined
        ? written({ changedAt: last.changed_at, messageId: last.id, asOf })
        : null,
    asOf: asOf.toISOString(),
  };
};
