/**
 * What the wedge's writes publish, and where: the channel's topic for what the room
 * sees, the person's own for what only they should (D-99).
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { ServerFrame, type Channel, type Topic } from '@purlay/types';
import { fixedClock } from './clock';
import {
  publishChannelAdded,
  publishChannelState,
  publishReactionsUpdated,
  publishThreadUpdated,
  type EventBus,
} from './events';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));
const ID = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const OTHER = '0199155c-6200-7b7f-8c11-2a4d3f9e1b71';
const user = { id: ID, username: 'alice', displayName: 'Alice', avatarUrl: null };

const recording = (): { bus: EventBus; sent: { topic: Topic; frame: ServerFrame }[] } => {
  const sent: { topic: Topic; frame: ServerFrame }[] = [];
  const bus: EventBus = {
    publish: (topic, frame) => {
      sent.push({ topic, frame });
      return Promise.resolve();
    },
    subscribe: () => true,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, sent };
};

describe('publishing the wedge', () => {
  test('a thread update goes to the channel, as a frame the contract accepts', async () => {
    const { bus, sent } = recording();
    const thread = {
      replyCount: 2,
      lastReplyAt: '2026-09-09T12:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    };
    await publishThreadUpdated(bus, clock, { channelId: ID, messageId: OTHER, thread });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.topic).toBe(`channel:${ID}`);
    expect(Value.Check(ServerFrame, sent[0]?.frame)).toBe(true);
    expect(sent[0]?.frame.ts).toBe(clock.now().getTime());
  });

  test('a reaction update goes to the channel and carries the whole set', async () => {
    const { bus, sent } = recording();
    await publishReactionsUpdated(bus, clock, {
      channelId: ID,
      messageId: OTHER,
      reactions: [{ emoji: '👍', userIds: [ID] }],
    });
    expect(sent[0]?.topic).toBe(`channel:${ID}`);
    expect(Value.Check(ServerFrame, sent[0]?.frame)).toBe(true);
  });

  /** What is true for one person must not be published where a room can hear it. */
  test('read state and a new channel go to that person alone', async () => {
    const { bus, sent } = recording();
    const state = { lastReadMessageId: null, unreadCount: 3, unreadMentionCount: 1 };
    const channel: Channel = {
      id: ID,
      workspaceId: OTHER,
      name: null,
      topic: null,
      type: 'direct_message',
      lastMessageAt: null,
      state,
      peer: user,
    };
    await publishChannelState(bus, clock, OTHER, ID, state);
    await publishChannelAdded(bus, clock, OTHER, channel);
    expect(sent.map((entry) => entry.topic)).toEqual([`user:${OTHER}`, `user:${OTHER}`]);
    for (const entry of sent) expect(Value.Check(ServerFrame, entry.frame)).toBe(true);
  });
});
