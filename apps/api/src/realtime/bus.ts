/**
 * The in-process event bus. Every fan-out goes through the `EventBus` interface
 * (`platform/events.ts`); this is the implementation one node needs.
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
import type { Deliver, EventBus, Topic } from '../platform/events';

/** What a test may ask of the in-process bus beyond the interface: how much it holds. */
export interface InspectableEventBus extends EventBus {
  readonly size: () => { readonly topics: number; readonly sockets: number };
}

export const inProcessEventBus = (deliver: Deliver): InspectableEventBus => {
  const byTopic = new Map<Topic, Set<string>>();
  const bySocket = new Map<string, Set<Topic>>();

  return {
    publish: async (topic: Topic, frame: ServerFrame): Promise<void> => {
      for (const socketId of byTopic.get(topic) ?? []) deliver(socketId, frame);
      // Asynchronous by interface, synchronous today. A caller that awaits it now
      // keeps working when the implementation behind it does reach a network.
      await Promise.resolve();
    },

    subscribe: (topic: Topic, socketId: string): boolean => {
      const sockets = byTopic.get(topic) ?? new Set<string>();
      const added = !sockets.has(socketId);
      sockets.add(socketId);
      byTopic.set(topic, sockets);

      const topics = bySocket.get(socketId) ?? new Set<Topic>();
      topics.add(topic);
      bySocket.set(socketId, topics);
      return added;
    },

    unsubscribe: (topic: Topic, socketId: string): void => {
      const sockets = byTopic.get(topic);
      sockets?.delete(socketId);
      // An empty set is a leak that grows with every channel anybody ever opened.
      if (sockets?.size === 0) byTopic.delete(topic);
      const topics = bySocket.get(socketId);
      topics?.delete(topic);
      // The same leak the other way round: one entry per socket that ever unsubscribed.
      if (topics?.size === 0) bySocket.delete(socketId);
    },

    forget: (socketId: string): void => {
      for (const topic of bySocket.get(socketId) ?? []) {
        const sockets = byTopic.get(topic);
        sockets?.delete(socketId);
        if (sockets?.size === 0) byTopic.delete(topic);
      }
      bySocket.delete(socketId);
    },

    size: () => ({ topics: byTopic.size, sockets: bySocket.size }),
  };
};
