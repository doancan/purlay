/**
 * The bus, on its own.
 *
 * Its whole job is fan-out and forgetting. The second half is what a long-running
 * process depends on: a topic set that is never cleaned up grows with every
 * channel anybody ever opened.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerFrame } from '@purlay/types';
import { inProcessEventBus } from './bus';
import { aRecordingLogger } from '../ingress/http/testing';
import { createLogger } from '../platform/logging';
import { channelTopic } from '../platform/events';

const aFrame = (data: unknown): ServerFrame =>
  ({ event: 'MESSAGE_CREATED', data, ts: 1 }) as ServerFrame;

const collecting = (): {
  bus: ReturnType<typeof inProcessEventBus>;
  sent: { socketId: string; data: unknown }[];
} => {
  const sent: { socketId: string; data: unknown }[] = [];
  const bus = inProcessEventBus(
    (socketId, frame) => {
      sent.push({ socketId, data: frame.data });
    },
    createLogger({ level: 'silent' }),
  );
  return { bus, sent };
};

describe('the event bus', () => {
  test('delivers to every subscriber of a topic, and to nobody else', async () => {
    const { bus, sent } = collecting();
    bus.subscribe(channelTopic('c1'), 'a');
    bus.subscribe(channelTopic('c1'), 'b');
    bus.subscribe(channelTopic('c2'), 'c');

    await bus.publish(channelTopic('c1'), aFrame('hello'));

    expect(sent.map((entry) => entry.socketId).sort()).toEqual(['a', 'b']);
  });

  test('publishing to a topic nobody watches reaches nobody, and does not throw', async () => {
    const { bus, sent } = collecting();
    await bus.publish(channelTopic('nobody-listens'), aFrame('nobody'));
    expect(sent).toEqual([]);
  });

  test('unsubscribing stops delivery', async () => {
    const { bus, sent } = collecting();
    bus.subscribe(channelTopic('c1'), 'a');
    bus.unsubscribe(channelTopic('c1'), 'a');
    await bus.publish(channelTopic('c1'), aFrame('hello'));
    expect(sent).toEqual([]);
  });

  /**
   * A socket that closes leaves nothing behind. Without this, the map grows with
   * every channel every connection ever subscribed to, for the life of the
   * process — a leak that only shows up after a long uptime, which is the worst
   * time to find one.
   */
  test('forgetting a socket removes it from every topic it was watching', async () => {
    const { bus, sent } = collecting();
    for (const channel of ['c1', 'c2', 'c3']) bus.subscribe(channelTopic(channel), 'a');
    bus.subscribe(channelTopic('c1'), 'b');

    bus.forget('a');

    for (const channel of ['c1', 'c2', 'c3']) {
      await bus.publish(channelTopic(channel), aFrame(channel));
    }
    expect(sent).toEqual([{ socketId: 'b', data: 'c1' }]);
  });

  test('subscribing twice delivers once, so a resubscribe is not a duplicate', async () => {
    const { bus, sent } = collecting();
    bus.subscribe(channelTopic('c1'), 'a');
    bus.subscribe(channelTopic('c1'), 'a');
    await bus.publish(channelTopic('c1'), aFrame('once'));
    expect(sent).toHaveLength(1);
  });

  /**
   * The message is already committed when the bus fans it out, so one socket whose
   * send throws must not cost the others the frame, and must not turn the
   * publisher's success into an error.
   */
  test('a delivery that throws is logged by socket, and the rest still receive the frame', async () => {
    const { log, lines } = aRecordingLogger();
    const received: string[] = [];
    const bus = inProcessEventBus((socketId) => {
      if (socketId === 'broken') throw new Error('the socket is gone');
      received.push(socketId);
    }, log);
    for (const id of ['a', 'broken', 'c']) bus.subscribe(channelTopic('c1'), id);

    await bus.publish(channelTopic('c1'), aFrame('private words'));

    expect(received.sort()).toEqual(['a', 'c']);
    const failure = lines.find((line) => line['msg'] === 'delivery to a socket failed');
    expect(failure).toMatchObject({ level: 'error', socketId: 'broken' });
    // Never the message: it is somebody's.
    expect(JSON.stringify(lines)).not.toContain('private words');
  });

  test('a socket that unsubscribes or is forgotten leaves nothing behind', () => {
    const { bus } = collecting();
    bus.subscribe(channelTopic('c1'), 'a');
    bus.subscribe(channelTopic('c2'), 'a');
    bus.subscribe(channelTopic('c1'), 'b');
    expect(bus.size()).toEqual({ topics: 2, sockets: 2 });

    bus.unsubscribe(channelTopic('c1'), 'a');
    bus.unsubscribe(channelTopic('c2'), 'a');
    expect(bus.size()).toEqual({ topics: 1, sockets: 1 });

    bus.forget('b');
    expect(bus.size()).toEqual({ topics: 0, sockets: 0 });
    // Forgetting what is not there is not an error.
    bus.forget('never-subscribed');
    expect(bus.size()).toEqual({ topics: 0, sockets: 0 });
  });
});
