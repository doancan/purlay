/**
 * Who is told of a person's presence, and what a workspace's presence is (#480, D-136).
 *
 * **Told to the people who share a workspace with them**, each on their own `user:` topic, as a
 * workspace change is (D-124): membership is read as the change is told, so somebody who shares no
 * workspace — or was removed a moment ago — hears nothing. What they hear is that the person has
 * Purlay open, never which workspace: a socket is no workspace's (D-136 §1).
 *
 * **A workspace's presence** is its members online now, for a member of it; anybody else is told the
 * workspace does not exist, as for every workspace route (D-34).
 */
import type { Executor } from '@purlay/db';
import type { PresenceChange, PresenceSnapshot } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { publication, publishAfterCommit, userTopic, type EventBus } from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { WorkspaceContext } from '../../platform/tenancy';
import { workspacesOf } from '../users/profile';

/** What a workspace's presence is read from: this node's record (`realtime/online.ts`). */
export interface OnlineReader {
  readonly onlineAmong: (userIds: readonly string[]) => Promise<readonly PresenceChange[]>;
  readonly version: () => number | Promise<number>;
}

/** Everybody who shares a workspace with the person, once each, never the person. */
const coMembers = async (executor: Executor, userId: string): Promise<readonly string[]> => {
  const everyone = new Set<string>();
  for (const workspace of await workspacesOf(executor, userId)) {
    for (const memberId of workspace.memberIds) if (memberId !== userId) everyone.add(memberId);
  }
  return [...everyone];
};

export const announcePresence = async (
  {
    database,
    bus,
    clock,
    log,
  }: {
    readonly database: Executor;
    readonly bus: EventBus;
    readonly clock: Clock;
    readonly log: Logger;
  },
  change: PresenceChange,
): Promise<void> => {
  const told = await coMembers(database, change.userId);
  await publishAfterCommit(log, [
    told.map((memberId) =>
      publication('PRESENCE', () =>
        bus.publish(userTopic(memberId), {
          event: 'PRESENCE',
          data: { changes: [change] },
          ts: clock.now().getTime(),
        }),
      ),
    ),
  ]);
};

/** `GET /api/workspaces/:workspaceId/presence` — for a member, the context says so already. */
export const workspacePresence = async (
  executor: Executor,
  context: WorkspaceContext,
  online: OnlineReader,
): Promise<PresenceSnapshot> => {
  const members = await executor
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .execute();
  // The version first: anybody who goes online after it is heard by a frame at a later one.
  const version = await online.version();
  return {
    online: [...(await online.onlineAmong(members.map((member) => member.user_id)))],
    version,
  };
};
