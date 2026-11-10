/**
 * Who is told of a person's presence, and what a workspace's presence is (#480, D-136).
 *
 * **Told to the people who share a workspace with them**, each on their own `user:` topic, as a
 * workspace change is (D-124): membership is read as the change is told, so somebody who shares no
 * workspace — or was removed a moment ago — hears nothing. What they hear is that the person has
 * Purlay open, never which workspace: a socket is no workspace's (D-136 §1). **And to the person
 * themselves**, on their own topic: it is their own state, so nothing new is told to anybody, and
 * every page of theirs draws their own avatar from what the server says of them — away by choice
 * from another device, or idle, which only the server knows (D-257).
 * Restricted guests hear only current colleagues in their explicitly shared conversations; snapshots
 * use the same directory boundary, including when expiry cleanup has not run.
 *
 * **A workspace's presence** is its members online now, for a member of it; anybody else is told the
 * workspace does not exist, as for every workspace route (D-34).
 *
 * **Away is idleness or the person's choice** (D-257): the node says whether they are idle, and their own
 * `users.away_chosen` is read here as the change is told, and as the snapshot is read, so the first change
 * heard after an arrival is already away for somebody who chose it — nobody sees active-then-away. Offline
 * wins: an offline change is never away, and nobody offline is in a snapshot.
 */
import type { ChatDb } from '../schema';
import { sql } from '@purlay/db';
import type { PresenceChange, PresenceSnapshot } from '@purlay/types';
import type { Clock } from '../../../platform/clock';
import {
  publication,
  type Publish,
  publishAfterCommit,
  userTopic,
  type EventBus,
} from '../../../platform/events';
import type { Logger } from '../../../platform/logging';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { channelAudienceQuery } from '../channels/guard';
import { chatGuestChannels } from '../channels/guest-grants';

/** What a workspace's presence is read from: this node's record (`realtime/online.ts`). */
export interface OnlineReader {
  readonly onlineAmong: (userIds: readonly string[]) => Promise<readonly PresenceChange[]>;
  readonly version: () => number | Promise<number>;
}

/** Everybody who shares a workspace with the person, once each, never the person. */
const coMembers = async (executor: ChatDb, userId: string): Promise<readonly string[]> => {
  const shared = executor
    .selectFrom('channel_members as speaker')
    .innerJoin('channels as shared_channel', 'shared_channel.id', 'speaker.channel_id')
    .select('speaker.channel_id')
    .where('speaker.user_id', '=', userId)
    .where('shared_channel.workspace_id', '=', sql.ref<string>('everyone.workspace_id'))
    .where(
      'speaker.user_id',
      'in',
      channelAudienceQuery(executor, sql.ref<string>('shared_channel.id')),
    )
    .where((eb) =>
      eb.exists(
        channelAudienceQuery(executor, sql.ref<string>('shared_channel.id')).where(
          'users.id',
          '=',
          sql.ref<string>('everyone.user_id'),
        ),
      ),
    );
  const rows = await executor
    .selectFrom('workspace_members as mine')
    .innerJoin('workspaces', 'workspaces.id', 'mine.workspace_id')
    .innerJoin('workspace_members as everyone', 'everyone.workspace_id', 'mine.workspace_id')
    .select('everyone.user_id')
    .distinct()
    .where('mine.user_id', '=', userId)
    .where('everyone.user_id', '<>', userId)
    .where('workspaces.deleted_at', 'is', null)
    .where((eb) => eb.or([eb('everyone.access_kind', '=', 'member'), eb.exists(shared)]))
    .execute();
  return rows.map((row) => row.user_id);
};

/** Whether the person chose to appear away; false for nobody (an account erased meanwhile). */
const awayChosen = async (executor: ChatDb, userId: string): Promise<boolean> =>
  (
    await executor
      .selectFrom('users')
      .select('away_chosen')
      .where('id', '=', userId)
      .executeTakeFirst()
  )?.away_chosen ?? false;

export const announcePresence = async (
  {
    database,
    bus,
    clock,
    log,
  }: {
    readonly database: ChatDb;
    readonly bus: EventBus;
    readonly clock: Clock;
    readonly log: Logger;
  },
  change: PresenceChange,
): Promise<void> => {
  const members = await coMembers(database, change.userId);
  const chosen = change.online && (await awayChosen(database, change.userId));
  const state: PresenceChange = { ...change, away: change.online && (change.away || chosen) };
  // The person last: their own pages follow their own state, as everybody else's do, and while they
  // are online they also hear whether the away is their choice, so every device's menu knows it (D-257).
  const own: PresenceChange = change.online ? { ...state, chosen } : state;
  const tell = (memberId: string, told: PresenceChange): Publish =>
    publication('PRESENCE', () =>
      bus.publish(userTopic(memberId), {
        event: 'PRESENCE',
        data: { changes: [told] },
        ts: clock.now().getTime(),
      }),
    );
  await publishAfterCommit(log, [
    [...members.map((memberId) => tell(memberId, state)), tell(change.userId, own)],
  ]);
};

/** `GET /api/workspaces/:workspaceId/presence` — for a member, the context says so already. */
export const workspacePresence = async (
  executor: ChatDb,
  context: WorkspaceContext,
  online: OnlineReader,
): Promise<PresenceSnapshot> => {
  const members = await executor
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .$if(context.guest !== undefined, (query) =>
      query.where(
        chatGuestChannels.people(executor, context, sql.ref<string>('workspace_members.user_id')),
      ),
    )
    .execute();
  // The version first: anybody who goes online after it is heard by a frame at a later one.
  const version = await online.version();
  const here = await online.onlineAmong(members.map((member) => member.user_id));
  // The choices last (D-257). A choice stored before this read is seen here; one stored after it is
  // told again at a version newer than any read above, which wins. Read before the record, a choice
  // stored between the reads would pair the old choice with the retelling's version — and a client
  // keeps the first it hears at a version, so the snapshot could stick until the next change.
  const chose = new Set(
    here.length === 0
      ? []
      : (
          await executor
            .selectFrom('users')
            .select('id')
            .where(
              'id',
              'in',
              here.map((change) => change.userId),
            )
            .where('away_chosen', '=', true)
            .execute()
        ).map((user) => user.id),
  );
  return {
    online: here.map((change) => ({ ...change, away: change.away || chose.has(change.userId) })),
    version,
  };
};
