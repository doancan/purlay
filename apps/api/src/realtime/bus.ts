/**
 * The event bus. Every fan-out goes through this interface.
 *
 * **Services publish and never touch a socket; the hub subscribes and never
 * touches the database.** That separation is the whole reason a later move to a
 * shared bus is an adapter swap rather than a refactor (D-7), and it is the only
 * thing that makes the seam real rather than claimed.
 *
 * Phase 0–2 is this: a map of topic to socket ids. No network, no serialisation,
 * no broker for a self-hosted instance to operate — which it will never need,
 * because one node serving thirty people does not (D-7, D-25).
 */
import type { ServerFrame } from '@purlay/types';

/** `workspace:{id}` · `channel:{id}` · `user:{id}` */
export type Topic = string;

export const workspaceTopic = (workspaceId: string): Topic => `workspace:${workspaceId}`;
export const channelTopic = (channelId: string): Topic => `channel:${channelId}`;
export const userTopic = (userId: string): Topic => `user:${userId}`;

/** What the bus hands a frame to. The hub implements it; nothing else needs to. */
export type Deliver = (socketId: string, frame: ServerFrame) => void;

export interface EventBus {
  publish: (topic: Topic, frame: ServerFrame) => Promise<void>;
  subscribe: (topic: Topic, socketId: string) => void;
  unsubscribe: (topic: Topic, socketId: string) => void;
  /** Everything this socket was listening to. Called once, when it closes. */
  forget: (socketId: string) => void;
}

export const inProcessEventBus = (deliver: Deliver): EventBus => {
  const byTopic = new Map<Topic, Set<string>>();
  const bySocket = new Map<string, Set<Topic>>();

  return {
    publish: async (topic: Topic, frame: ServerFrame): Promise<void> => {
      for (const socketId of byTopic.get(topic) ?? []) deliver(socketId, frame);
      // Asynchronous by interface, synchronous today. A caller that awaits it now
      // keeps working when the implementation behind it does reach a network.
      await Promise.resolve();
    },

    subscribe: (topic: Topic, socketId: string): void => {
      const sockets = byTopic.get(topic) ?? new Set<string>();
      sockets.add(socketId);
      byTopic.set(topic, sockets);

      const topics = bySocket.get(socketId) ?? new Set<Topic>();
      topics.add(topic);
      bySocket.set(socketId, topics);
    },

    unsubscribe: (topic: Topic, socketId: string): void => {
      const sockets = byTopic.get(topic);
      sockets?.delete(socketId);
      // An empty set is a leak that grows with every channel anybody ever opened.
      if (sockets?.size === 0) byTopic.delete(topic);
      bySocket.get(socketId)?.delete(topic);
    },

    forget: (socketId: string): void => {
      for (const topic of bySocket.get(socketId) ?? []) {
        const sockets = byTopic.get(topic);
        sockets?.delete(socketId);
        if (sockets?.size === 0) byTopic.delete(topic);
      }
      bySocket.delete(socketId);
    },
  };
};
