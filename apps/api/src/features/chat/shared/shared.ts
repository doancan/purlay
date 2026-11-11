/** Filter and authorize source messages in SQL before ordering, page limits or indexing status. */
import { jsonArrayFrom, sql, type SelectQueryBuilder } from '@purlay/db';
import type { SharedItem, SharedPage, SharedQuery, SharedOrigin, User } from '@purlay/types';
import { AppError } from '../../../platform/errors';
import { literalPattern } from '../../../platform/like-pattern';
import { limitOf } from '../../../platform/pagination';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { asAttachment } from '../../../modules/attachments/uploads';
import type { ChatDb, ChatSchema } from '../schema';
import { requireChannelById, channelNotFound, withinMessageHistory } from '../channels/guard';
import { notHiddenBy } from '../messages/hidden';
import { sharedCursor } from './cursor';
import { sharedFilters } from './filters';

const originColumns = [
  'messages.id as messageId',
  'messages.parent_id as parentId',
  'messages.channel_id as channelId',
  'messages.created_at as sentAt',
  sql<User | null>`case when author.id is null then null else json_build_object(
    'id',author.id,'username',author.username,'displayName',author.display_name,'avatarUrl',author.avatar_url) end`.as(
    'sender',
  ),
  sql<
    string | null
  >`case when messages.metadata->>'kind' = 'incoming_webhook' then messages.metadata->>'name' end`.as(
    'sourceName',
  ),
] as const;

const originOf = (
  row: Omit<SharedOrigin, 'sentAt'> & { readonly sentAt: Date | string },
): SharedOrigin => ({
  messageId: row.messageId,
  parentId: row.parentId,
  channelId: row.channelId,
  sender: row.sender,
  sourceName: row.sourceName,
  sentAt: new Date(row.sentAt).toISOString(),
});

const readableMessages = (
  db: ChatDb,
  context: WorkspaceContext,
  query: SharedQuery,
): SelectQueryBuilder<ChatSchema, 'messages', object> => {
  let source = db
    .selectFrom('messages')
    .where('messages.workspace_id', '=', context.workspaceId)
    .where(withinMessageHistory(db, context))
    .where(notHiddenBy(context.userId))
    .where('messages.deleted_at', 'is', null);
  if (query.channelId !== undefined)
    source = source.where('messages.channel_id', '=', query.channelId);
  if (query.senderId !== undefined)
    source = source.where('messages.sender_id', '=', query.senderId);
  if (query.since !== undefined)
    source = source.where('messages.created_at', '>=', new Date(query.since));
  if (query.until !== undefined)
    source = source.where('messages.created_at', '<', new Date(query.until));
  return source;
};

export const sharedIn = async (
  db: ChatDb,
  context: WorkspaceContext,
  input: SharedQuery,
): Promise<SharedPage> => {
  const query = sharedFilters(input);
  if (query.view === 'links' && query.type !== undefined)
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'File type applies to files.',
      details: { fields: { type: 'Choose the Files tab.' } },
    });
  if (
    query.since !== undefined &&
    query.until !== undefined &&
    new Date(query.since) >= new Date(query.until)
  )
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The end must follow the start.',
      details: { fields: { until: 'Must be after the start.' } },
    });
  if (query.channelId !== undefined) {
    const channel = await requireChannelById(db, context.userId, query.channelId);
    if (channel.workspaceId !== context.workspaceId) throw channelNotFound();
  }
  const cursor = sharedCursor(context, query);
  const before = cursor.before;
  const limit = limitOf(query);
  const words = query.q?.trim() ?? '';
  if (query.view === 'files') {
    let files = readableMessages(db, context, query)
      .innerJoin('message_attachments as carried', 'carried.message_id', 'messages.id')
      .innerJoin('attachments', 'attachments.id', 'carried.attachment_id')
      .leftJoin('users as author', 'author.id', 'messages.sender_id')
      .where('carried.workspace_id', '=', context.workspaceId)
      .select(originColumns)
      .select([
        'attachments.id',
        'attachments.workspace_id',
        'attachments.uploader_id',
        'attachments.file_name',
        'attachments.mime_type',
        'attachments.size_bytes',
        'attachments.kind',
        'attachments.width',
        'attachments.height',
      ])
      .orderBy('carried.message_id', 'desc')
      .orderBy('carried.attachment_id', 'desc')
      .limit(limit + 1);
    if (words !== '')
      files = files.where(
        sql<boolean>`purlay_fold(attachments.file_name) like purlay_fold(${literalPattern(words)})`,
      );
    if (query.type === 'pdf') files = files.where('attachments.mime_type', '=', 'application/pdf');
    else if (query.type === 'other')
      files = files
        .where('attachments.kind', '=', 'file')
        .where('attachments.mime_type', '<>', 'application/pdf');
    else if (query.type !== undefined) files = files.where('attachments.kind', '=', query.type);
    if (cursor.before !== undefined)
      files = files.where(
        sql<boolean>`(carried.message_id,carried.attachment_id) < (${cursor.before.message}::uuid,${cursor.before.key}::uuid)`,
      );
    const rows = await files.execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row): SharedItem => ({
        ...originOf(row),
        kind: 'file',
        attachment: asAttachment(row),
      })),
      nextCursor:
        rows.length > limit && last !== undefined ? cursor.next(last.messageId, last.id) : null,
      indexing: false,
    };
  }
  let links = readableMessages(db, context, query)
    .innerJoin('message_shared_links as link', 'link.message_id', 'messages.id')
    .leftJoin('users as author', 'author.id', 'messages.sender_id')
    .where('link.workspace_id', '=', context.workspaceId)
    .where(
      sql<boolean>`not exists (select 1 from message_shared_jobs where message_id = messages.id)`,
    )
    .select(originColumns)
    .select(['link.link_key as key', 'link.url', 'link.label'])
    .orderBy('link.message_id', 'desc')
    .orderBy('link.link_key')
    .limit(limit + 1);
  if (words !== '')
    links = links.where(
      sql<boolean>`(purlay_fold(link.label) like purlay_fold(${literalPattern(words)}) or purlay_fold(link.url) like purlay_fold(${literalPattern(words)}))`,
    );
  if (before !== undefined)
    links = links.where((eb) =>
      eb.or([
        eb('link.message_id', '<', before.message),
        eb.and([eb('link.message_id', '=', before.message), eb('link.link_key', '>', before.key)]),
      ]),
    );
  // One PostgreSQL snapshot for both the list and its coverage: completion cannot stop polling
  // between a page read and a later status read. Dirty projections are excluded until replaced.
  const waiting = readableMessages(db, context, query)
    .where((eb) =>
      eb.or([
        sql<boolean>`exists (select 1 from message_shared_jobs where message_id = messages.id)`,
        sql<boolean>`exists (select 1 from shared_link_backfill progress where progress.name = 'links'
      and not progress.complete and (progress.before_message_id is null or messages.id < progress.before_message_id))`,
      ]),
    )
    .select('messages.id')
    .limit(1);
  const result = await db
    .selectNoFrom([
      jsonArrayFrom(links).as('rows'),
      sql<boolean>`exists (${waiting})`.as('indexing'),
    ])
    .executeTakeFirstOrThrow();
  const rows = result.rows;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map((row): SharedItem => ({
      ...originOf(row),
      kind: 'link',
      key: row.key,
      link: { url: row.url, label: row.label },
    })),
    nextCursor:
      rows.length > limit && last !== undefined ? cursor.next(last.messageId, last.key) : null,
    indexing: result.indexing,
  };
};
