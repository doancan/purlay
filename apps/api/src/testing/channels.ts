/**
 * A channel to send into, for tests that call the messages module directly.
 *
 * The database only: no session, no HTTP. `testing/signed-in.ts` is for the tests
 * that go through a request.
 */
import type { Executor } from '@purlay/db';
import { DEFAULT_CHANNEL_NAME } from '@purlay/types';
import { requireChannelById, type ChannelContext } from '../platform/channels';
import { aUniqueSlug, aUserRow } from './users';

/** A member of a workspace they own, with one public channel they are in — a writer's (D-156). */
export const aChannel = async (db: Executor): Promise<ChannelContext> => {
  const user = await aUserRow(db, 'send-user');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Send', slug: aUniqueSlug('send') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: user.userId, role: 'owner' })
    .execute();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('channel_members')
    .values({ channel_id: channel.id, user_id: user.userId })
    .execute();
  return await requireChannelById(db, user.userId, channel.id);
};

/**
 * The channel a workspace made through `POST /api/workspaces` starts with, its creator in it
 * (D-174): the "workspace with a channel" a test through the API stands on. Read by its name, which
 * is the only thing that marks it, and refused loudly when it is not there.
 */
export const theDefaultChannelOf = async (db: Executor, workspaceId: string): Promise<string> =>
  (
    await db
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('name', '=', DEFAULT_CHANNEL_NAME)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow()
  ).id;
