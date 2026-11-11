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
import { sql } from '@purlay/db';
import type { ChatDb } from '../schema';
import { CHANGES_OVERLAP_MS, PAGE_LIMIT, type ChangePage, type ChangesQuery } from '@purlay/types';
import { AppError } from '../../../platform/errors';
import { withinMessageHistory, type ChannelContext } from '../channels/guard';
import { buildMessages, MESSAGE_COLUMNS, type MessageRow } from './reader';

/** The database's own clock, to the millisecond a stamp is kept to. */
const serverNow = async (executor: ChatDb): Promise<Date> => {
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

/**
 * A walk that has this many changes or fewer ahead of it is read by their ids; a longer one is read as the
 * channel. An empty poll is the common walk, and the channel's own scan answers it in a time that grows with the
 * channel (#1018) — `greatest(changed_at, hidden_at)` is no column, so no index can answer it. The ids can be read
 * from the two indexes that do hold the columns; but a catch-up from a year ago would read nearly the whole of
 * them twice and be slower than the scan, so the read of ids gives up at this many and the scan takes over.
 */
export const IDS_READ_MAX = 1000;

export interface ChangedRows {
  readonly rows: readonly (MessageRow & { readonly changed_at: Date })[];
  /** How the rows were found: `ids` from the two indexes, `scan` as the whole channel. */
  readonly read: 'ids' | 'scan';
}

export interface ChangeWindow {
  /** Nothing stamped later than this is in the walk. */
  readonly asOf: Date;
  readonly after: Cursor | undefined;
  /** Nothing stamped before this is in the walk: the cursor's own stamp, or `since` less the overlap. */
  readonly from: Date;
  readonly limit: number;
}

/**
 * The ids of what changed at or after `from`, for the caller and the channel: a message stamped then, or one
 * the caller hid then. `undefined` when there are more than `IDS_READ_MAX`, the point where the channel's scan is
 * cheaper than reading them.
 *
 * A row in the walk has `greatest(changed_at, hidden_at)` after `from`, so one of the two is at or after it: the
 * ids are a superset of the walk and the statement that follows keeps every one of its own conditions. A message
 * changed between this read and that statement is not in the ids; it is stamped after `asOf` or it is inside the
 * overlap of the next walk, as a commit that lands after any read always has been.
 */
const idsChangedFrom = async (
  executor: ChatDb,
  context: ChannelContext,
  from: Date,
): Promise<string[] | undefined> => {
  const found = await executor
    .selectFrom('messages')
    .select('messages.id')
    .where('messages.channel_id', '=', context.channelId)
    .where('messages.changed_at', '>=', from)
    .unionAll(
      executor
        .selectFrom('hidden_messages')
        .select('hidden_messages.message_id as id')
        .where('hidden_messages.user_id', '=', context.userId)
        .where('hidden_messages.channel_id', '=', context.channelId)
        .where('hidden_messages.hidden_at', '>=', from),
    )
    .limit(IDS_READ_MAX + 1)
    .execute();
  return found.length > IDS_READ_MAX ? undefined : found.map(({ id }) => id);
};

/**
 * The page's rows, in the order things happened. `strategy: 'scan'` is the read of the whole channel and is kept for
 * the test that holds the other to it: whatever one finds, the other finds, to the byte.
 */
export const changedRows = async (
  executor: ChatDb,
  context: ChannelContext,
  window: ChangeWindow,
  strategy: 'auto' | 'scan' = 'auto',
): Promise<ChangedRows> => {
  const ids =
    strategy === 'scan' ? undefined : await idsChangedFrom(executor, context, window.from);
  if (ids?.length === 0) return { rows: [], read: 'ids' };

  const changedAt = sql<Date>`greatest(messages.changed_at, personal.hidden_at)`;
  let statement = executor
    .selectFrom('messages')
    .leftJoin('hidden_messages as personal', (join) =>
      join
        .onRef('personal.message_id', '=', 'messages.id')
        .on('personal.user_id', '=', context.userId),
    )
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .select(changedAt.as('changed_at'))
    .where('messages.channel_id', '=', context.channelId)
    .where(withinMessageHistory(executor, context))
    .where(changedAt, '<=', window.asOf)
    .orderBy(changedAt, 'asc')
    .orderBy('messages.id', 'asc')
    // One more than a page: whether another page exists is answered by reading, not by a COUNT.
    .limit(window.limit);

  if (ids !== undefined) statement = statement.where('messages.id', 'in', ids);
  statement =
    window.after === undefined
      ? statement.where(changedAt, '>', window.from)
      : statement.where(
          sql<boolean>`(${changedAt}, messages.id) > (${window.after.changedAt}, ${window.after.messageId}::uuid)`,
        );
  return {
    rows: await statement.execute(),
    read: ids === undefined ? ('scan' as const) : ('ids' as const),
  };
};

export const changesIn = async (
  executor: ChatDb,
  context: ChannelContext,
  query: ChangesQuery,
): Promise<ChangePage> => {
  if (query.since !== undefined && query.after !== undefined) {
    throw refused('after', 'cannot be combined with `since`');
  }
  const limit = Math.min(Math.max(query.limit ?? PAGE_LIMIT.default, 1), PAGE_LIMIT.max);

  const cursor = query.after === undefined ? undefined : read(query.after);
  const since = query.since === undefined ? undefined : new Date(query.since);
  if (since !== undefined && Number.isNaN(since.getTime())) {
    throw refused('since', 'is not a time');
  }
  const from = cursor?.changedAt ?? (since && new Date(since.getTime() - CHANGES_OVERLAP_MS));
  const now = await serverNow(executor);
  // Only the watermark: where this server's clock is, for a client with nothing to ask since.
  if (from === undefined) return { data: [], nextCursor: null, asOf: now.toISOString() };
  // A cursor is made here and is never later than the clock that made it: one that says otherwise would hand a
  // client a watermark this server never held, and the client would keep it and be told nothing for ever after.
  if (cursor !== undefined && (cursor.asOf > now || cursor.changedAt > cursor.asOf)) {
    throw refused('after', 'is not a cursor this server made');
  }
  const asOf = cursor?.asOf ?? now;

  const { rows } = await changedRows(executor, context, {
    asOf,
    after: cursor,
    from,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: await buildMessages(executor, page, context.userId),
    nextCursor:
      rows.length > limit && last !== undefined
        ? written({ changedAt: last.changed_at, messageId: last.id, asOf })
        : null,
    asOf: asOf.toISOString(),
  };
};
