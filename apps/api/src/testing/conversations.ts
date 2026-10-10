/**
 * Workspaces, channels and messages for the tests that need a conversation with
 * several people in it, written straight into the database.
 *
 * Straight in, not through the send path: a test of the read position must control
 * exactly which rows exist past it, including the ones the send path would have
 * counted for itself. What these write is what a send writes, no more.
 */
import type { Executor } from '@purlay/db';
import { aUniqueSlug, aUserRow, type TestUser } from './users';

export interface Conversation {
  readonly workspaceId: string;
  readonly users: readonly TestUser[];
}

/** A workspace and its members, the first of them the owner. */
export const aConversation = async (
  db: Executor,
  ...names: readonly string[]
): Promise<Conversation> => {
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Talk', slug: aUniqueSlug('talk') })
    .returning('id')
    .executeTakeFirstOrThrow();
  const users: TestUser[] = [];
  for (const name of names) {
    const user = await aUserRow(db, name);
    users.push(user);
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: workspace.id,
        user_id: user.userId,
        role: users.length === 1 ? 'owner' : 'member',
      })
      .execute();
  }
  return { workspaceId: workspace.id, users };
};

/** A public channel with these people in it. */
export const aChannelWith = async (
  db: Executor,
  workspaceId: string,
  name: string,
  ...members: readonly TestUser[]
): Promise<string> => {
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspaceId, name, type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const member of members) {
    await db
      .insertInto('channel_members')
      .values({ channel_id: channel.id, user_id: member.userId })
      .execute();
  }
  return channel.id;
};

export interface SeededMessage {
  readonly parentId?: string;
  readonly deleted?: boolean;
}

/** A message, newer than every one this process made before it. */
export const aMessageIn = async (
  db: Executor,
  scope: { readonly workspaceId: string; readonly channelId: string },
  sender: TestUser,
  options: SeededMessage = {},
): Promise<string> => {
  const id = Bun.randomUUIDv7();
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: scope.workspaceId,
      channel_id: scope.channelId,
      sender_id: sender.userId,
      content: 'hello',
      parent_id: options.parentId ?? null,
      deleted_at: options.deleted === true ? new Date('2026-01-01T00:00:00.000Z') : null,
    })
    .execute();
  return id;
};
