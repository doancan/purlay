/** A person's own channel headings; every write joins the request's transaction (#1198). */
import { Value } from '@sinclair/typebox/value';
import { sql } from '@purlay/db';
import {
  CHANNEL_GROUP_LIMIT,
  Uuid,
  type ChannelGroup,
  type ChannelGroupPage,
  type ChannelGroupQuery,
} from '@purlay/types';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { AppError } from '../../../platform/errors';
import { limitOf } from '../../../platform/pagination';
import type { ChatDb, ChatTx } from '../schema';
import { channelNotFound, type ChannelContext } from './guard';

const missing = (): AppError =>
  new AppError({ code: 'CHANNEL_GROUP_NOT_FOUND', message: 'Channel group not found.' });

const named = (row: ChannelGroup): ChannelGroup => ({
  id: row.id,
  name: row.name,
  collapsed: row.collapsed,
});

/** The owner's existing membership serializes cap checks and name changes across devices. */
const lockOwner = async (db: ChatTx, context: WorkspaceContext): Promise<void> => {
  const row = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw missing();
};

export const listGroups = async (
  db: ChatDb,
  context: WorkspaceContext,
  page: ChannelGroupQuery,
): Promise<ChannelGroupPage> => {
  const limit = limitOf(page);
  let query = db
    .selectFrom('channel_groups')
    .select(['id', 'name', 'collapsed'])
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (page.before !== undefined) query = query.where('id', '<', page.before);
  const rows = await query.execute();
  const data = rows.slice(0, limit).map(named);
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
};

export const saveGroup = async (
  db: ChatTx,
  context: WorkspaceContext,
  id: string,
  inputName: string,
): Promise<{ readonly group: ChannelGroup; readonly changed: boolean }> => {
  if (!Value.Check(Uuid, id)) throw missing();
  const name = inputName.trim().normalize('NFC');
  if (name === '')
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Name the channel group.',
      details: { fields: { name: 'Required.' } },
    });
  await lockOwner(db, context);
  const existing = await db
    .selectFrom('channel_groups')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (
    existing !== undefined &&
    (existing.user_id !== context.userId || existing.workspace_id !== context.workspaceId)
  )
    throw missing();
  if (existing?.name === name) return { group: named(existing), changed: false };
  const taken = await db
    .selectFrom('channel_groups')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .where('name_key', '=', sql<string>`lower(${name})`)
    .where('id', '!=', id)
    .executeTakeFirst();
  if (taken !== undefined)
    throw new AppError({
      code: 'CHANNEL_GROUP_NAME_TAKEN',
      message: 'A channel group with that name already exists.',
    });
  if (existing === undefined) {
    const count = await db
      .selectFrom('channel_groups')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('workspace_id', '=', context.workspaceId)
      .where('user_id', '=', context.userId)
      .executeTakeFirstOrThrow();
    if (count.count >= CHANNEL_GROUP_LIMIT)
      throw new AppError({
        code: 'CHANNEL_GROUP_LIMIT',
        message: 'Remove a channel group before adding another.',
      });
  }
  const row = await db
    .insertInto('channel_groups')
    .values({ id, workspace_id: context.workspaceId, user_id: context.userId, name })
    .onConflict((conflict) =>
      conflict
        .column('id')
        .doUpdateSet({ name })
        .where('channel_groups.workspace_id', '=', context.workspaceId)
        .where('channel_groups.user_id', '=', context.userId),
    )
    .returning(['id', 'name', 'collapsed'])
    .executeTakeFirst();
  if (row === undefined) throw missing();
  return { group: named(row), changed: true };
};

export const foldGroup = async (
  db: ChatTx,
  context: WorkspaceContext,
  id: string,
  collapsed: boolean,
): Promise<{ readonly group: ChannelGroup; readonly changed: boolean }> => {
  if (!Value.Check(Uuid, id)) throw missing();
  const row = await db
    .updateTable('channel_groups')
    .set({ collapsed })
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .where('id', '=', id)
    .where('collapsed', '!=', collapsed)
    .returning(['id', 'name', 'collapsed'])
    .executeTakeFirst();
  if (row !== undefined) return { group: named(row), changed: true };
  const unchanged = await db
    .selectFrom('channel_groups')
    .select(['id', 'name', 'collapsed'])
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (unchanged === undefined) throw missing();
  return { group: named(unchanged), changed: false };
};

/** Foreign and absent ids both have no effect and give the same answer. */
export const removeGroup = async (
  db: ChatTx,
  context: WorkspaceContext,
  id: string,
): Promise<boolean> => {
  if (!Value.Check(Uuid, id)) throw missing();
  const row = await db
    .deleteFrom('channel_groups')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
};

/** Serialize a move and a star on the same membership: a channel has one visible placement. */
export const moveToGroup = async (
  db: ChatTx,
  context: ChannelContext,
  groupId: string | null,
): Promise<boolean> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  const member = await db
    .selectFrom('channel_members')
    .select('starred_at')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .forUpdate()
    .executeTakeFirst();
  if (member === undefined) throw channelNotFound();
  if (groupId !== null) {
    if (!Value.Check(Uuid, groupId)) throw missing();
    const group = await db
      .selectFrom('channel_groups')
      .select('id')
      .where('id', '=', groupId)
      .where('workspace_id', '=', context.workspaceId)
      .where('user_id', '=', context.userId)
      .forKeyShare()
      .executeTakeFirst();
    if (group === undefined) throw missing();
  }
  const before = await db
    .selectFrom('channel_group_channels')
    .select('group_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if ((before?.group_id ?? null) === groupId && member.starred_at === null) return false;
  if (groupId === null) {
    await db
      .deleteFrom('channel_group_channels')
      .where('channel_id', '=', context.channelId)
      .where('user_id', '=', context.userId)
      .execute();
  } else {
    await db
      .insertInto('channel_group_channels')
      .values({ channel_id: context.channelId, user_id: context.userId, group_id: groupId })
      .onConflict((conflict) =>
        conflict.columns(['channel_id', 'user_id']).doUpdateSet({ group_id: groupId }),
      )
      .execute();
  }
  if (member.starred_at !== null)
    await db
      .updateTable('channel_members')
      .set({ starred_at: null })
      .where('channel_id', '=', context.channelId)
      .where('user_id', '=', context.userId)
      .execute();
  return true;
};
