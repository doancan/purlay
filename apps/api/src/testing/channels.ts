/**
 * A channel to send into, for tests that call the messages module directly.
 *
 * The database only: no session, no HTTP. `testing/signed-in.ts` is for the tests
 * that go through a request.
 */
import type { Executor } from '@purlay/db';
import { requireChannelById, type ChannelContext } from '../platform/channels';
import { aUniqueSlug, aUserRow } from './users';

/** A member of a workspace they own, with one public channel. */
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
  return await requireChannelById(db, user.userId, channel.id);
};
