/**
 * A channel with several people in it, for tests of what a message does to them.
 *
 * `testing/channels.ts` makes one member and one channel, which is enough to send a
 * message and not enough to ask who it was *for*. Counters, mentions and
 * notifications are about the others in the room, so this builds the others: real
 * users, real memberships, and a `ChannelContext` per member made by the guard, the
 * only way one is made (D-34).
 */
import type { Executor } from '@purlay/db';
import { requireChannelById, type ChannelContext } from '../platform/channels';
import { aUniqueSlug, aUserRow } from './users';

export interface Room {
  readonly workspaceId: string;
  readonly channelId: string;
  /** Each member of the channel by the name the test gave them. */
  readonly members: Readonly<
    Record<
      string,
      {
        readonly userId: string;
        readonly username: string;
        /** This member's right to send into the channel. */
        readonly context: ChannelContext;
      }
    >
  >;
  /** Workspace members who are not in the channel, by name. */
  readonly outsiders: Readonly<
    Record<string, { readonly userId: string; readonly username: string }>
  >;
}

export interface RoomOptions {
  /** `direct_message` needs exactly two members, or one for a note to self. */
  readonly type?: 'public' | 'private' | 'direct_message';
  /** People who belong to the workspace and not to the channel. */
  readonly outsiders?: readonly string[];
}

/** The first name is the sender in most tests; everyone is in the channel unless listed as an outsider. */
/** When every member of a test room joined it: earlier than any test's fixed clock. */
const ROOM_JOINED_AT = new Date('2026-01-01T00:00:00.000Z');

export const aRoom = async (
  db: Executor,
  names: readonly string[],
  options: RoomOptions = {},
): Promise<Room> => {
  const type = options.type ?? 'public';
  const people = await Promise.all(
    names.map(async (name) => ({ name, ...(await aUserRow(db, name)) })),
  );
  const outsiders = await Promise.all(
    (options.outsiders ?? []).map(async (name) => ({ name, ...(await aUserRow(db, name)) })),
  );

  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Room', slug: aUniqueSlug('room') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values(
      [...people, ...outsiders].map((person, index) => ({
        workspace_id: workspace.id,
        user_id: person.userId,
        role: index === 0 ? ('owner' as const) : ('member' as const),
      })),
    )
    .execute();

  const dmKey =
    type === 'direct_message'
      ? // Everybody in it, sorted (a group of up to ten, D-127); a note to oneself is the pair of
        // a person with themselves (I-5).
        (people.length === 1
          ? [people[0]?.userId, people[0]?.userId]
          : people.map((person) => person.userId)
        )
          .sort()
          .join(':')
      : null;
  const channel = await db
    .insertInto('channels')
    .values({
      workspace_id: workspace.id,
      name: type === 'direct_message' ? null : 'general',
      type,
      dm_key: dmKey,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('channel_members')
    .values(
      [...new Set(people.map((person) => person.userId))].map((userId) => ({
        channel_id: channel.id,
        user_id: userId,
        // Before any test's clock, not the database's: whether somebody was in the channel when
        // a message was written is a comparison with this, and a wall-clock value would make it
        // depend on the day the test runs.
        joined_at: ROOM_JOINED_AT,
      })),
    )
    .execute();

  const members: Record<string, Room['members'][string]> = {};
  for (const person of people) {
    members[person.name] = {
      userId: person.userId,
      username: person.username,
      context: await requireChannelById(db, person.userId, channel.id),
    };
  }
  return {
    workspaceId: workspace.id,
    channelId: channel.id,
    members,
    outsiders: Object.fromEntries(
      outsiders.map((person) => [
        person.name,
        { userId: person.userId, username: person.username },
      ]),
    ),
  };
};

/** One member's read position and counters, straight from the row. */
export const counters = async (
  db: Executor,
  room: Pick<Room, 'channelId'>,
  userId: string,
): Promise<{ unread: number; mentions: number; lastRead: string | null }> => {
  const row = await db
    .selectFrom('channel_members')
    .select(['unread_count', 'unread_mention_count', 'last_read_message_id'])
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return {
    unread: row.unread_count,
    mentions: row.unread_mention_count,
    lastRead: row.last_read_message_id,
  };
};

/**
 * The notifications a person holds, as `type` per message, ordered by message id and
 * type. Not by time: inside a test's one transaction every row has the same
 * `created_at`, and an order that depends on it is a flaky test waiting.
 */
export const notificationsOf = async (
  db: Executor,
  userId: string,
): Promise<readonly { messageId: string; type: string }[]> =>
  (
    await db
      .selectFrom('notifications')
      .select(['message_id', 'type'])
      .where('user_id', '=', userId)
      .orderBy('message_id')
      .orderBy('type')
      .execute()
  ).map((row) => ({ messageId: row.message_id, type: row.type }));
