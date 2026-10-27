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
 * back to replay from their cursors (D-190): the cursor logic is untouched, it is what is used. A frame that
 * never reached Redis leaves the others' subscriptions up, so each carries its publisher's name and a count, and
 * a hole in a count is a gap too. The one
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
  /** Which backplane published it, and its count: a hole in the count is a frame that never arrived. */
  readonly origin: string;
  readonly seq: number;
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
  const origin: unknown = Reflect.get(parsed, 'origin');
  const seq: unknown = Reflect.get(parsed, 'seq');
  if (typeof origin !== 'string' || typeof seq !== 'number') return undefined;
  // The topic's shape is the contract's; a frame is checked as far as the hub reads it.
  return { topic: topic as Topic, frame: frame as ServerFrame, origin, seq };
};

interface Node {
  readonly fanOut: (topic: Topic, frame: ServerFrame) => void;
  readonly gap: (() => void) | undefined;
}

export const redisBackplane = (link: RedisLink, log: Logger): Backplane => {
  const nodes = new Set<Node>();
  /** This backplane's name on the channel, and how many frames it has tried to publish. */
  const origin = crypto.randomUUID();
  let published = 0;
  /** The last count heard from each backplane. A restarted one starts again at one, which is no hole. */
  const heardFrom = new Map<string, number>();
  const tellGap = (): void => {
    for (const node of nodes) node.gap?.();
  };
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
    const before = heardFrom.get(envelope.origin);
    heardFrom.delete(envelope.origin);
    heardFrom.set(envelope.origin, envelope.seq);
    // Bounded: a node that restarts is a new name, and the oldest names are not heard from again.
    if (heardFrom.size > 1_000) heardFrom.delete(heardFrom.keys().next().value ?? '');
    fanOutHere(envelope.topic, envelope.frame);
    // A frame that its publisher could not get to Redis leaves a hole in its count, and nobody's
    // subscription was ever lost: this is the only place the others can find out.
    if (envelope.origin !== origin && before !== undefined && envelope.seq > before + 1) {
      log.warn('a frame was lost between nodes; sockets are sent back to replay it', {
        missed: envelope.seq - before - 1,
      });
      tellGap();
    }
  });
  link.onResubscribed(() => {
    log.warn('the shared bus was away; sockets are sent back to replay what they missed');
    tellGap();
  });

  return {
    node: (deliver: Deliver, nodeLog: Logger, onGap?: () => void): InspectableEventBus => {
      const local = subscriptionsOf(deliver, nodeLog);
      nodes.add({ fanOut: local.fanOut, gap: onGap });
      return {
        publish: async (topic: Topic, frame: ServerFrame): Promise<void> => {
          // Its echo comes back only while the subscription is up.
          let here = !link.subscribed();
          published += 1;
          try {
            await link.send('PUBLISH', [
              BUS_CHANNEL,
              JSON.stringify({ topic, frame, origin, seq: published }),
            ]);
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
