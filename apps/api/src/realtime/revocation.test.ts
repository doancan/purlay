/**
 * Revocation across nodes, without a database or a socket: two hubs, each with its
 * own sockets, sharing one backplane — what Phase 3's Redis adapter gives two
 * processes. A change published from either node, or from a third that holds no
 * sockets, must end delivery on both (#238, D-85).
 */
import { describe, expect, test } from 'bun:test';
import { CLOSE_CODES, type ServerFrame } from '@purlay/types';
import { aDatabaseThatMustNotBeTouched } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import {
  channelTopic,
  publishAccessRevoked,
  publishChannelRevoked,
  publishUserDeleted,
  sessionTopic,
  userTopic,
} from '../platform/events';
import { createLogger } from '../platform/logging';
import { inProcessBackplane, type InspectableEventBus } from './bus';
import { createSocketHub, type SocketHub } from './hub';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));
const log = createLogger({ level: 'silent' });

const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';

const aMessage = (channelId: string, id: string): ServerFrame =>
  ({ event: 'MESSAGE_CREATED', data: { id, channelId }, ts: 1 }) as ServerFrame;

/** Every frame whose data names a channel: the ones a refused or revoked channel must drop. */
type ChannelFrameEvent = Extract<ServerFrame, { data: { channelId: string } }>['event'];

/**
 * One frame of every kind that is about a channel, for it (#412). Each names the channel in its
 * data, so a filter that knows only `MESSAGE_CREATED` lets the rest through. Keyed by the event, so
 * a new kind of channel frame does not compile here until it has a sample — a hand-kept list missed
 * `CHANNEL_UPDATED` once.
 */
const everyChannelFrame = (channelId: string): ServerFrame[] => {
  const samples: Record<ChannelFrameEvent, unknown> = {
    MESSAGE_CREATED: aMessage(channelId, 'created'),
    THREAD_UPDATED: {
      event: 'THREAD_UPDATED',
      data: { channelId, messageId: 'm' },
      version: 1,
      ts: 1,
    },
    REACTIONS_UPDATED: {
      event: 'REACTIONS_UPDATED',
      data: { channelId, messageId: 'm' },
      version: 1,
      ts: 1,
    },
    MESSAGE_REVISED: {
      event: 'MESSAGE_REVISED',
      data: { channelId, messageId: 'm', content: 'secret' },
      ts: 1,
    },
    CHANNEL_STATE: { event: 'CHANNEL_STATE', data: { channelId }, version: 1, ts: 1 },
    CHANNEL_UPDATED: {
      event: 'CHANNEL_UPDATED',
      data: { channelId, name: 'secret-name', topic: null },
      version: 1,
      ts: 1,
    },
    PINS_UPDATED: { event: 'PINS_UPDATED', data: { channelId }, ts: 1 },
    MESSAGE_VERSIONS_UPDATED: {
      event: 'MESSAGE_VERSIONS_UPDATED',
      data: { channelId, messageId: channelId },
      ts: 1,
    },
    TYPING: { event: 'TYPING', data: { channelId, userId: 'u', ttlMs: 1 }, ts: 1 },
  };
  return Object.values(samples) as ServerFrame[];
};

interface Node {
  readonly hub: SocketHub;
  readonly bus: InspectableEventBus;
  /** What each socket on this node was sent or closed with, in order. */
  readonly seen: Map<string, string[]>;
  readonly open: (socketId: string) => Promise<void>;
}

const aNode = (backplane: ReturnType<typeof inProcessBackplane>): Node => {
  const seen = new Map<string, string[]>();
  const hub = createSocketHub(aDatabaseThatMustNotBeTouched(), clock, {
    log,
    leave: (channelId, socketId) => {
      bus.unsubscribe(channelTopic(channelId), socketId);
    },
    listen: () => undefined,
  });
  const bus = backplane.node(hub.deliver, log);
  return {
    hub,
    bus,
    seen,
    open: async (socketId): Promise<void> => {
      const events: string[] = [];
      seen.set(socketId, events);
      // No cookie, so no identity and the hub closes it as signed out at once;
      // the registration is what delivery needs, and the noise is cleared.
      await hub.opened(
        socketId,
        {
          send: (payload) => events.push((JSON.parse(payload) as { event: string }).event),
          buffered: () => 0,
          close: (code) => events.push(`close ${String(code)}`),
        },
        new Request('https://purlay.test/ws'),
      );
      events.length = 0;
    },
  };
};

describe('a session that ends, on two nodes', () => {
  test('closes its sockets on the node that did not publish, and only that session’s', async () => {
    const backplane = inProcessBackplane();
    const a = aNode(backplane);
    const b = aNode(backplane);
    await a.open('a1');
    await b.open('b1');
    await b.open('b-other-session');
    a.bus.subscribe(sessionTopic('S1'), 'a1');
    b.bus.subscribe(sessionTopic('S1'), 'b1');
    b.bus.subscribe(sessionTopic('S2'), 'b-other-session');

    await a.bus.publish(sessionTopic('S1'), {
      event: 'SESSION_ENDED',
      data: { reason: 'signed-out' },
      ts: 1,
    });

    const ended = ['SESSION_ENDED', `close ${String(CLOSE_CODES.SESSION_ENDED)}`];
    expect(a.seen.get('a1')).toEqual(ended);
    expect(b.seen.get('b1')).toEqual(ended);
    expect(b.seen.get('b-other-session')).toEqual([]);
  });

  test('a deleted user’s sockets close on every node, whichever session they hold', async () => {
    const backplane = inProcessBackplane();
    const a = aNode(backplane);
    const b = aNode(backplane);
    const publisher = aNode(backplane);
    await a.open('a1');
    await b.open('b1');
    await b.open('someone-else');
    a.bus.subscribe(userTopic('alice'), 'a1');
    b.bus.subscribe(userTopic('alice'), 'b1');
    b.bus.subscribe(userTopic('bob'), 'someone-else');

    await publishUserDeleted(publisher.bus, clock, 'alice');

    const ended = ['SESSION_ENDED', `close ${String(CLOSE_CODES.SESSION_ENDED)}`];
    expect(a.seen.get('a1')).toEqual(ended);
    expect(b.seen.get('b1')).toEqual(ended);
    expect(b.seen.get('someone-else')).toEqual([]);
  });
});

describe('a membership that ends, on two nodes', () => {
  const setup = async (): Promise<{ a: Node; b: Node; publisher: Node }> => {
    const backplane = inProcessBackplane();
    const a = aNode(backplane);
    const b = aNode(backplane);
    const publisher = aNode(backplane);
    // Alice on node B watches both channels; Bob on node A watches the first.
    await b.open('alice');
    await a.open('bob');
    for (const channel of [C1, C2]) b.bus.subscribe(channelTopic(channel), 'alice');
    a.bus.subscribe(channelTopic(C1), 'bob');
    b.bus.subscribe(userTopic('alice'), 'alice');
    a.bus.subscribe(userTopic('bob'), 'bob');
    return { a, b, publisher };
  };

  test('stops one channel for that user, tells them, and leaves the rest and everyone else alone', async () => {
    const { a, b, publisher } = await setup();
    // The control: before the revocation both channels reach alice.
    await publisher.bus.publish(channelTopic(C1), aMessage(C1, 'm0'));
    await publisher.bus.publish(channelTopic(C2), aMessage(C2, 'm0'));
    expect(b.seen.get('alice')).toEqual(['MESSAGE_CREATED', 'MESSAGE_CREATED']);
    b.seen.get('alice')?.splice(0);

    await publishAccessRevoked(publisher.bus, clock, 'alice', [C1]);
    await publisher.bus.publish(channelTopic(C1), aMessage(C1, 'm1'));
    await publisher.bus.publish(channelTopic(C2), aMessage(C2, 'm1'));

    // Told, still connected, and still receiving the channel she keeps.
    expect(b.seen.get('alice')).toEqual(['ACCESS_REVOKED', 'MESSAGE_CREATED']);
    // Bob, on the other node, watches the same channel and is untouched.
    expect(a.seen.get('bob')).toEqual(['MESSAGE_CREATED', 'MESSAGE_CREATED']);
  });

  test('a channel that goes away stops for everyone watching it, on both nodes', async () => {
    const { a, b, publisher } = await setup();
    a.seen.get('bob')?.splice(0);
    b.seen.get('alice')?.splice(0);

    await publishChannelRevoked(publisher.bus, clock, C1);
    await publisher.bus.publish(channelTopic(C1), aMessage(C1, 'after'));
    await publisher.bus.publish(channelTopic(C2), aMessage(C2, 'after'));

    expect(a.seen.get('bob')).toEqual(['ACCESS_REVOKED']);
    expect(b.seen.get('alice')).toEqual(['ACCESS_REVOKED', 'MESSAGE_CREATED']);
  });

  test('a revocation that arrives behind a replay takes effect at once, and what was kept is forgotten', async () => {
    const { b, publisher } = await setup();
    b.seen.get('alice')?.splice(0);
    b.hub.hold('alice');
    await publisher.bus.publish(channelTopic(C1), aMessage(C1, 'kept'));
    await publisher.bus.publish(channelTopic(C2), aMessage(C2, 'kept'));
    expect(b.seen.get('alice')).toEqual([]);

    await publishAccessRevoked(publisher.bus, clock, 'alice', [C1]);
    // Nothing more for C1 can reach her, even before the replay is written.
    await publisher.bus.publish(channelTopic(C1), aMessage(C1, 'later'));
    b.hub.reply('alice', []);

    // C2's kept frame, then the notice; C1's kept and later frames are gone.
    expect(b.seen.get('alice')).toEqual(['MESSAGE_CREATED', 'ACCESS_REVOKED']);
  });

  test('a revocation behind a replay forgets every kind of frame kept for the channel (#412)', async () => {
    const { b, publisher } = await setup();
    b.seen.get('alice')?.splice(0);
    b.hub.hold('alice');
    for (const frame of everyChannelFrame(C1)) await publisher.bus.publish(channelTopic(C1), frame);
    await publisher.bus.publish(channelTopic(C2), aMessage(C2, 'kept'));

    await publishAccessRevoked(publisher.bus, clock, 'alice', [C1]);
    b.hub.reply('alice', []);

    expect(b.seen.get('alice')).toEqual(['MESSAGE_CREATED', 'ACCESS_REVOKED']);
  });

  test('frames about the person, not a channel, kept behind a replay are released, not forgotten', async () => {
    const { b, publisher } = await setup();
    b.seen.get('alice')?.splice(0);
    b.hub.hold('alice');
    await publisher.bus.publish(userTopic('alice'), {
      event: 'DEEP_WORK_UPDATED',
      data: { workspaceId: 'w', until: null },
      ts: 1,
    });
    await publisher.bus.publish(userTopic('alice'), {
      event: 'SAVED_UPDATED',
      data: { workspaceId: 'w' },
      ts: 1,
    });
    await publisher.bus.publish(userTopic('alice'), {
      event: 'WORKSPACE_UPDATED',
      data: { workspaceId: 'w' },
      ts: 1,
    });
    await publisher.bus.publish(channelTopic(C1), aMessage(C1, 'kept'));
    await publishAccessRevoked(publisher.bus, clock, 'alice', [C1]);
    b.hub.reply('alice', []);
    expect(b.seen.get('alice')).toEqual([
      'DEEP_WORK_UPDATED',
      'SAVED_UPDATED',
      'WORKSPACE_UPDATED',
      'ACCESS_REVOKED',
    ]);
  });

  test('frames kept for channels a refused subscription named are dropped, not released with the error', async () => {
    const { b, publisher } = await setup();
    b.seen.get('alice')?.splice(0);
    b.hub.hold('alice');
    await publisher.bus.publish(channelTopic(C1), aMessage(C1, 'not hers'));
    await publisher.bus.publish(channelTopic(C2), aMessage(C2, 'hers'));
    b.hub.drop('alice', [C1]);
    b.hub.reply('alice', []);
    expect(b.seen.get('alice')).toEqual(['MESSAGE_CREATED']);
  });

  /**
   * #412: an edit's words, a thread's summary, a reaction set — anything published for the channel
   * while it was being refused. Released with the error, it tells an outsider what the 404 hid.
   */
  test('every kind of frame kept for a refused channel is dropped, not only new messages', async () => {
    const { b, publisher } = await setup();
    b.seen.get('alice')?.splice(0);
    b.hub.hold('alice');
    for (const frame of everyChannelFrame(C1)) await publisher.bus.publish(channelTopic(C1), frame);
    await publisher.bus.publish(channelTopic(C2), aMessage(C2, 'hers'));
    b.hub.drop('alice', [C1]);
    b.hub.reply('alice', []);
    expect(b.seen.get('alice')).toEqual(['MESSAGE_CREATED']);
  });
});
