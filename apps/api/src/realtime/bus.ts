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
 *
 * **A node is a view onto a backplane.** Each node holds its own sockets'
 * subscriptions and delivers only to them; a publish from any node reaches every
 * node's subscribers of that topic. In production there is one node and the
 * backplane is private to it. Two nodes sharing one backplane — what the tests
 * build — are exactly what Phase 3's Redis adapter provides across processes, so
 * "a revoked session closes its sockets on the other node too" is demonstrated
 * here rather than argued (D-85).
 */
import type { ServerFrame } from '@purlay/types';
import type { Deliver, EventBus, Topic } from '../platform/events';
import type { Logger } from '../platform/logging';

/** What a test may ask of the in-process bus beyond the interface: how much it holds. */
export interface InspectableEventBus extends EventBus {
  readonly size: () => { readonly topics: number; readonly sockets: number };
}

export interface Subscriptions extends Omit<InspectableEventBus, 'publish'> {
  readonly fanOut: (topic: Topic, frame: ServerFrame) => void;
}

/** One node's subscriptions: which of its sockets listen to which topic. */
export const subscriptionsOf = (deliver: Deliver, log: Logger): Subscriptions => {
  const byTopic = new Map<Topic, Set<string>>();
  const bySocket = new Map<string, Set<Topic>>();

  return {
    fanOut: (topic: Topic, frame: ServerFrame): void => {
      // A snapshot, and each delivery on its own: the message is already committed,
      // so one socket whose send throws must neither stop the rest from receiving
      // it nor surface as an error to the publisher. Logged with the socket's id
      // and never the frame, which is somebody's message. (A snapshot also because
      // delivering a revocation unsubscribes from the topic being walked.)
      for (const socketId of [...(byTopic.get(topic) ?? [])]) {
        try {
          deliver(socketId, frame);
        } catch (error) {
          log.error('delivery to a socket failed', { socketId, topic, err: error });
        }
      }
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

/** The shared transport nodes publish through. Phase 3's Redis adapter is this, across processes. */
export interface Backplane {
  /**
   * `onGap` is told when frames may have been missed: a shared backplane lost its connection and has it
   * again (`redis-bus.ts`). The in-process one never is. The caller's answer is to send its sockets back to
   * replay from their cursors, which is what a restart does (D-190).
   */
  readonly node: (deliver: Deliver, log: Logger, onGap?: () => void) => InspectableEventBus;
}

export const inProcessBackplane = (): Backplane => {
  const nodes = new Set<(topic: Topic, frame: ServerFrame) => void>();
  return {
    node: (deliver, log): InspectableEventBus => {
      const local = subscriptionsOf(deliver, log);
      nodes.add(local.fanOut);
      return {
        publish: async (topic: Topic, frame: ServerFrame): Promise<void> => {
          for (const fanOut of nodes) fanOut(topic, frame);
          // Asynchronous by interface, synchronous today. A caller that awaits it now
          // keeps working when the implementation behind it does reach a network.
          await Promise.resolve();
        },
        subscribe: local.subscribe,
        unsubscribe: local.unsubscribe,
        forget: local.forget,
        size: local.size,
      };
    },
  };
};

/** One node on a backplane of its own: what a single process runs. */
export const inProcessEventBus = (deliver: Deliver, log: Logger): InspectableEventBus =>
  inProcessBackplane().node(deliver, log);
