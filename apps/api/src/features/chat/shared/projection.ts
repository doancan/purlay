/** Rebuildable link projection. The caller owns the source row in its transaction before replacing its links. */
import { createHash } from 'node:crypto';
import { sql } from '@purlay/db';
import { parseMarkdown, sharedLinksOf } from '@purlay/markdown';
import type { SharedLink } from '@purlay/types';
import { atomicallyOn } from '../../../platform/transactions';
import type { ChatDb, ChatSchema } from '../schema';

interface LinkSource {
  readonly messageId: string;
  readonly workspaceId: string;
  readonly channelId: string;
}
type LinkRow = ChatSchema['message_shared_links'];
const rowsOf = (source: LinkSource, links: readonly SharedLink[]): readonly LinkRow[] =>
  links.map((link) => ({
    message_id: source.messageId,
    workspace_id: source.workspaceId,
    channel_id: source.channelId,
    link_key: createHash('sha256').update(link.url).digest('hex'),
    ...link,
  }));

const upsertRows = async (db: ChatDb, rows: readonly LinkRow[]): Promise<void> => {
  const first = rows[0];
  if (first === undefined) return;
  await db
    .with('projected_shared_links', (tx) =>
      tx
        .insertInto('message_shared_links')
        .values(rows)
        .onConflict((conflict) =>
          conflict.columns(['message_id', 'link_key']).doUpdateSet({
            url: sql<string>`excluded.url`,
            label: sql<string>`excluded.label`,
          }),
        )
        .returning('message_id'),
    )
    .deleteFrom('message_shared_jobs')
    .where('message_id', '=', first.message_id)
    .execute();
};

/** New-source projection stays in its writer transaction. Empty text adds no catalogue SQL. */
export const addSharedLinks = async (
  db: ChatDb,
  source: LinkSource,
  links: readonly SharedLink[],
): Promise<void> => {
  await upsertRows(db, rowsOf(source, links));
};

export const replaceSharedLinks = async (
  db: ChatDb,
  source: LinkSource,
  links: readonly SharedLink[],
): Promise<void> => {
  const rows = rowsOf(source, links);
  let stale = db.deleteFrom('message_shared_links').where('message_id', '=', source.messageId);
  if (rows.length > 0)
    stale = stale.where(
      'link_key',
      'not in',
      rows.map((row) => row.link_key),
    );
  await stale.execute();
  await upsertRows(db, rows);
};

/** A historical interval is advanced only after its source jobs are durable. Source key-share locks
 * precede child writes; NOWAIT rolls back the entire interval rather than skipping a deletion hole. */
const seedHistory = async (db: ChatDb, batch: number): Promise<void> => {
  try {
    await atomicallyOn(db)(async (tx) => {
      const progress = await tx
        .selectFrom('shared_link_backfill')
        .selectAll()
        .where('name', '=', 'links')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (progress === undefined || progress.complete) return;
      let sources = tx
        .selectFrom('messages')
        .select(['id', 'workspace_id', 'channel_id'])
        .orderBy('id', 'desc')
        .limit(batch)
        .forKeyShare()
        .noWait();
      if (progress.before_message_id !== null)
        sources = sources.where('id', '<', progress.before_message_id);
      const rows = await sources.execute();
      if (rows.length > 0)
        await tx
          .insertInto('message_shared_jobs')
          .values(
            rows.map((row) => ({
              message_id: row.id,
              workspace_id: row.workspace_id,
              channel_id: row.channel_id,
            })),
          )
          .onConflict((conflict) => conflict.column('message_id').doNothing())
          .execute();
      await tx
        .updateTable('shared_link_backfill')
        .set({
          before_message_id: rows.at(-1)?.id ?? progress.before_message_id,
          complete: rows.length < batch,
        })
        .where('name', '=', 'links')
        .execute();
    });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== '55P03') throw error;
  }
};

/** Every writer is captured by the source trigger. Workers lock the source before its pending child,
 * so a commit, retry or rollback cannot lose an edit; only derived rows are written. */
export const backfillSharedLinks = async (db: ChatDb, batch = 100): Promise<number> => {
  if (!Number.isInteger(batch) || batch < 1 || batch > 100)
    throw new Error('Invalid Shared backfill batch');
  await seedHistory(db, batch);
  let indexed = 0;
  for (let n = 0; n < batch; n++) {
    const found = await atomicallyOn(db)(async (tx) => {
      const row = await tx
        .selectFrom('messages')
        .innerJoin('message_shared_jobs as pending', 'pending.message_id', 'messages.id')
        .select([
          'messages.id',
          'messages.workspace_id',
          'messages.channel_id',
          'messages.content',
          'messages.message_type',
          'messages.metadata',
          'messages.deleted_at',
        ])
        .orderBy('pending.queued_at')
        .orderBy('messages.id')
        .forNoKeyUpdate(['messages'])
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return false;
      const incoming =
        typeof row.metadata === 'object' &&
        row.metadata !== null &&
        !Array.isArray(row.metadata) &&
        'kind' in row.metadata &&
        row.metadata['kind'] === 'incoming_webhook';
      const links =
        row.deleted_at === null && (row.message_type === 'text' || incoming)
          ? sharedLinksOf(parseMarkdown(row.content))
          : [];
      await replaceSharedLinks(
        tx,
        { messageId: row.id, workspaceId: row.workspace_id, channelId: row.channel_id },
        links,
      );
      await tx.deleteFrom('message_shared_jobs').where('message_id', '=', row.id).execute();
      return true;
    });
    if (!found) break;
    indexed++;
  }
  return indexed;
};
