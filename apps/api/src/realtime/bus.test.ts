/**
 * The bus, on its own.
 *
 * Its whole job is fan-out and forgetting. The second half is what a long-running
 * process depends on: a topic set that is never cleaned up grows with every
 * channel anybody ever opened.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerFrame } from '@purlay/types';
import { channelTopic, inProcessEventBus, workspaceTopic } from './bus';

const aFrame = (data: unknown): ServerFrame =>
  ({ event: 'MESSAGE_CREATED', data, ts: 1 }) as ServerFrame;

const collecting = (): {
  bus: ReturnType<typeof inProcessEventBus>;
  sent: { socketId: string; data: unknown }[];
} => {
  const sent: { socketId: string; data: unknown }[] = [];
  const bus = inProcessEventBus((socketId, frame) => {
    sent.push({ socketId, data: frame.data });
  });
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
    await bus.publish(workspaceTopic('w1'), aFrame('nobody'));
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
});
