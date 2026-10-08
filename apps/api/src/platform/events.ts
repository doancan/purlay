/**
 * The event bus seam, and the names of what travels on it (`ARCHITECTURE.md` §6).
 *
 * The interface lives here, at the bottom, because both sides of it are above:
 * services publish (`modules`), the hub subscribes (`realtime`). Kept in
 * `realtime`, a service that publishes would import the layer that imports it.
 * The implementation — a map in this process today, a shared adapter in Phase 3 —
 * is not here, and nothing that publishes can tell which one it has (D-7).
 */
import type { ServerFrame, Topic } from '@purlay/types';

/** The contract's, not a second definition: the topic names cross nodes in Phase 3. */
export type { Topic };

export const workspaceTopic = (workspaceId: string): Topic => `workspace:${workspaceId}`;
export const channelTopic = (channelId: string): Topic => `channel:${channelId}`;
export const userTopic = (userId: string): Topic => `user:${userId}`;
export const sessionTopic = (sessionId: string): Topic => `session:${sessionId}`;

/** What the bus hands a frame to. The hub implements it; nothing else needs to. */
export type Deliver = (socketId: string, frame: ServerFrame) => void;

export interface EventBus {
  readonly publish: (topic: Topic, frame: ServerFrame) => Promise<void>;
  readonly subscribe: (topic: Topic, socketId: string) => void;
  readonly unsubscribe: (topic: Topic, socketId: string) => void;
  /** Everything this socket was listening to. Called once, when it closes. */
  readonly forget: (socketId: string) => void;
}
