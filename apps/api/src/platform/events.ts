/**
 * The event bus seam, and the names of what travels on it (`ARCHITECTURE.md` §6).
 *
 * The interface lives here, at the bottom, because both sides of it are above:
 * services publish (`modules`), the hub subscribes (`realtime`). Kept in
 * `realtime`, a service that publishes would import the layer that imports it.
 * The implementation — a map in this process today, a shared adapter in Phase 3 —
 * is not here, and nothing that publishes can tell which one it has (D-7).
 */
import {
  ACCESS_REVOKED_MAX_CHANNELS,
  type Channel,
  type ChannelState,
  type Reaction,
  type ServerFrame,
  type ThreadSummary,
  type Topic,
} from '@purlay/types';
import type { Clock } from './clock';

/** The contract's, not a second definition: the topic names cross nodes in Phase 3. */
export type { Topic };

/**
 * A builder for each topic something publishes on today. `workspace:` is in the
 * contract for what Phase 1 publishes, and gets a builder with it — an export
 * nothing calls is dead code (`CONTRIBUTING.md` §1.13).
 */
export const channelTopic = (channelId: string): Topic => `channel:${channelId}`;
export const sessionTopic = (sessionId: string): Topic => `session:${sessionId}`;
export const userTopic = (userId: string): Topic => `user:${userId}`;

/**
 * What a change that removes visibility publishes (D-85). Each is called **after**
 * the change commits, by the service that made it, with the bus it was given — a
 * socket is never told it lost something that was then rolled back.
 *
 * Phase 0 has no endpoint that removes a member, leaves a channel, deletes a
 * channel or deletes a user, so nothing calls these yet but the tests. Phase 1's
 * do, and are required to: remove member (#51), leave channel and delete channel
 * (#98), and the deletion of a user.
 */

/**
 * One user lost access to these channels — removed from a workspace (every channel
 * of it they could see), removed from a private channel, or left one. Their
 * sockets, on any node, stop receiving the channels and are told; they stay open.
 */
export const publishAccessRevoked = async (
  bus: EventBus,
  clock: Clock,
  userId: string,
  channelIds: readonly string[],
): Promise<void> => {
  for (let at = 0; at < channelIds.length; at += ACCESS_REVOKED_MAX_CHANNELS) {
    await bus.publish(userTopic(userId), {
      event: 'ACCESS_REVOKED',
      data: { channelIds: channelIds.slice(at, at + ACCESS_REVOKED_MAX_CHANNELS) },
      ts: clock.now().getTime(),
    });
  }
};

/** A channel went away: everyone watching it, on any node, stops receiving it. */
export const publishChannelRevoked = async (
  bus: EventBus,
  clock: Clock,
  channelId: string,
): Promise<void> => {
  await bus.publish(channelTopic(channelId), {
    event: 'ACCESS_REVOKED',
    data: { channelIds: [channelId] },
    ts: clock.now().getTime(),
  });
};

/**
 * These sessions were signed out: every socket each holds, on any node, is told and
 * closed. Published after the revocation is written, so a socket is never closed
 * for a sign-out that did not happen (#194).
 */
export const publishSessionsEnded = async (
  bus: EventBus,
  clock: Clock,
  sessionIds: readonly string[],
): Promise<void> => {
  for (const sessionId of sessionIds) {
    await bus.publish(sessionTopic(sessionId), {
      event: 'SESSION_ENDED',
      data: { reason: 'signed-out' },
      ts: clock.now().getTime(),
    });
  }
};

/** The user was deleted: every socket they hold, on any node, is told and closed. */
export const publishUserDeleted = async (
  bus: EventBus,
  clock: Clock,
  userId: string,
): Promise<void> => {
  await bus.publish(userTopic(userId), {
    event: 'SESSION_ENDED',
    data: { reason: 'account-deleted' },
    ts: clock.now().getTime(),
  });
};

/**
 * What the wedge's writes tell the room and the person (D-99). Each is called
 * **after** the change commits, like the revocations above, so nobody is told of
 * something that was then rolled back; each takes the bus it was given.
 */

/** A root's replies changed — a reply arrived, or the thread was resolved or reopened. */
export const publishThreadUpdated = async (
  bus: EventBus,
  clock: Clock,
  data: { readonly channelId: string; readonly messageId: string; readonly thread: ThreadSummary },
): Promise<void> => {
  await bus.publish(channelTopic(data.channelId), {
    event: 'THREAD_UPDATED',
    data,
    ts: clock.now().getTime(),
  });
};

/** A message's reactions changed. The whole set, so a client replaces rather than patches. */
export const publishReactionsUpdated = async (
  bus: EventBus,
  clock: Clock,
  data: {
    readonly channelId: string;
    readonly messageId: string;
    readonly reactions: readonly Reaction[];
  },
): Promise<void> => {
  await bus.publish(channelTopic(data.channelId), {
    event: 'REACTIONS_UPDATED',
    data: { ...data, reactions: [...data.reactions] },
    ts: clock.now().getTime(),
  });
};

/** One person's read position and counters in one channel, for every socket they hold. */
export const publishChannelState = async (
  bus: EventBus,
  clock: Clock,
  userId: string,
  channelId: string,
  state: ChannelState,
): Promise<void> => {
  await bus.publish(userTopic(userId), {
    event: 'CHANNEL_STATE',
    data: { channelId, state },
    ts: clock.now().getTime(),
  });
};

/** A channel appeared for one person — somebody opened a direct message with them. */
export const publishChannelAdded = async (
  bus: EventBus,
  clock: Clock,
  userId: string,
  channel: Channel,
): Promise<void> => {
  await bus.publish(userTopic(userId), {
    event: 'CHANNEL_ADDED',
    data: channel,
    ts: clock.now().getTime(),
  });
};

/** What the bus hands a frame to. The hub implements it; nothing else needs to. */
export type Deliver = (socketId: string, frame: ServerFrame) => void;

export interface EventBus {
  readonly publish: (topic: Topic, frame: ServerFrame) => Promise<void>;
  /** True when the socket was not already listening — what a failed frame has to undo. */
  readonly subscribe: (topic: Topic, socketId: string) => boolean;
  readonly unsubscribe: (topic: Topic, socketId: string) => void;
  /** Everything this socket was listening to. Called once, when it closes. */
  readonly forget: (socketId: string) => void;
}
