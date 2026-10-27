/**
 * The event bus several nodes share (D-201, D-7): the `Backplane` a second process can join, over Redis.
 *
 * **One channel for the whole cluster, filtered here.** A node subscribes once, to `purlay:bus`, and every
 * frame published anywhere arrives on it and is fanned out to the sockets this node holds for its topic. The
 * alternative, a Redis channel per topic, needs a `SUBSCRIBE` to be acknowledged before the hub may replay
 * from the database (D-82's order: listen, then read), and the interface's `subscribe` is synchronous and
 * answers at once — a frame published between the two would be lost for good. With one standing subscription
 * there is no such window. The cost is that each node hears every frame and drops those nobody here wants:
 * at D-25's ceiling (100 messages a second) that is a few kilobytes a second a node.
 *
 * **Exactly once, in order.** A publisher never fans out itself; it publishes, and hears its own frame back
 * on the subscription like every other node, so a frame is delivered once on each node. Redis delivers one
 * publisher's frames to a subscriber in the order they were published, and two publishers' to every
 * subscriber in the same order, so the order a channel's sockets see is the order Redis took them in.
 *
 * **When Redis is away** (D-201), frames are delivered to this node's own sockets and nowhere else: the
 * people on this node still hear each other. If only the subscription is down, the frame is also published,
 * for the other nodes, and delivered here directly, since its echo will not come. When the subscription is
 * made again, frames published meanwhile were missed, so each node is told (`onGap`) and sends its sockets
 * back to replay from their cursors (D-190): the cursor logic is untouched, it is what is used. The one
 * duplicate this allows is a publish that timed out after Redis had taken it; a frame is idempotent on its id
 * and version, and a client keeps the larger.
 */
import type { ServerFrame } from '@purlay/types';
import type { Deliver, Topic } from '../platform/events';
import type { Logger } from '../platform/logging';
import type { RedisLink } from '../platform/redis';
import { subscriptionsOf, type Backplane, type InspectableEventBus } from './bus';

export const BUS_CHANNEL = 'purlay:bus';

interface Envelope {
  readonly topic: Topic;
  readonly frame: ServerFrame;
}

/** What crosses between nodes is checked on arrival: another version of the server wrote it. */
const envelopeOf = (message: string): Envelope | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const topic: unknown = Reflect.get(parsed, 'topic');
  const frame: unknown = Reflect.get(parsed, 'frame');
  if (typeof topic !== 'string' || typeof frame !== 'object' || frame === null) return undefined;
  if (typeof Reflect.get(frame, 'event') !== 'string') return undefined;
  // The topic's shape is the contract's; a frame is checked as far as the hub reads it.
  return { topic: topic as Topic, frame: frame as ServerFrame };
};

interface Node {
  readonly fanOut: (topic: Topic, frame: ServerFrame) => void;
  readonly gap: (() => void) | undefined;
}

export const redisBackplane = (link: RedisLink, log: Logger): Backplane => {
  const nodes = new Set<Node>();
  const fanOutHere = (topic: Topic, frame: ServerFrame): void => {
    for (const node of nodes) node.fanOut(topic, frame);
  };

  link.subscribe(BUS_CHANNEL, (message) => {
    const envelope = envelopeOf(message);
    if (envelope === undefined) {
      // Never the message: it is somebody's.
      log.warn('a frame from the shared bus could not be read; dropped', { bytes: message.length });
      return;
    }
    fanOutHere(envelope.topic, envelope.frame);
  });
  link.onResubscribed(() => {
    log.warn('the shared bus was away; sockets are sent back to replay what they missed');
    for (const node of nodes) node.gap?.();
  });

  return {
    node: (deliver: Deliver, nodeLog: Logger, onGap?: () => void): InspectableEventBus => {
      const local = subscriptionsOf(deliver, nodeLog);
      nodes.add({ fanOut: local.fanOut, gap: onGap });
      return {
        publish: async (topic: Topic, frame: ServerFrame): Promise<void> => {
          // Its echo comes back only while the subscription is up.
          let here = !link.subscribed();
          try {
            await link.send('PUBLISH', [BUS_CHANNEL, JSON.stringify({ topic, frame })]);
          } catch (error) {
            here = true;
            log.warn('the shared bus did not take a frame; delivering on this node only', {
              topic,
              err: error,
            });
          }
          if (here) fanOutHere(topic, frame);
        },
        subscribe: local.subscribe,
        unsubscribe: local.unsubscribe,
        forget: local.forget,
        size: local.size,
      };
    },
  };
};
