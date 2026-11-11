/**
 * The hub's two promises that a real socket test cannot cheaply make: a thirty-day
 * expiry neither fires at once nor never, and the end of a session is announced
 * before the connection closes (#194).
 */
import { describe, expect, test } from 'bun:test';
import { CLOSE_CODES, MAX_FRAME_BYTES, type ServerFrame } from '@purlay/types';
import { anAuthThatMustNotBeTouched } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { DEFAULT_DEADLINE_MS } from '../platform/request-deadline';
import { createLogger } from '../platform/logging';
import {
  after,
  createSocketHub,
  FRAME_QUEUE_MAX,
  HELD_FRAMES_MAX,
  MAX_TIMER_MS,
  OUTBOUND_HIGH_WATER_MARK,
  type Connection,
  type Timers,
} from './hub';
import { REPLAY_BYTES_MAX } from '../features/chat/messages/replay';

/** Timers that record what was asked of them and fire only when told. */
const recordedTimers = (): Timers & {
  readonly pending: { readonly ms: number; readonly fire: () => void }[];
  readonly cleared: unknown[];
} => {
  const pending: { ms: number; fire: () => void; handle: number }[] = [];
  const cleared: unknown[] = [];
  let next = 0;
  return {
    pending,
    cleared,
    set: (callback: () => void, ms: number): number => {
      next += 1;
      pending.push({ ms, fire: callback, handle: next });
      return next;
    },
    clear: (handle: unknown): void => {
      cleared.push(handle);
    },
  };
};

const DAY = 24 * 60 * 60 * 1000;

describe('restricted live channel delivery', () => {
  const channelId = '11111111-1111-4111-8111-111111111111';
  const revision = (id: string, content = 'private words'): ServerFrame => ({
    event: 'MESSAGE_REVISED',
    data: {
      channelId,
      messageId: id,
      parentId: null,
      content,
      editedAt: null,
      deletedAt: null,
      mentions: [],
    },
    version: 1,
    ts: 1,
  });
  const rig = async (): Promise<{
    hub: ReturnType<typeof createSocketHub>;
    sent: ServerFrame[];
    closes: number[];
    timers: ReturnType<typeof recordedTimers>;
    clock: { now: () => Date };
  }> => {
    const sent: ServerFrame[] = [];
    const closes: number[] = [];
    const timers = recordedTimers();
    const clock = { now: (): Date => new Date('2026-11-10T00:00:00Z') };
    const hub = createSocketHub(anAuthThatMustNotBeTouched(), clock, {
      log: createLogger({ level: 'silent' }),
      leave: () => undefined,
      listen: () => undefined,
      timers,
    });
    await hub.opened(
      'guest',
      {
        send: (payload) => {
          sent.push(JSON.parse(payload) as ServerFrame);
          return payload.length;
        },
        buffered: () => 0,
        close: (code) => {
          closes.push(code);
        },
      },
      new Request('https://purlay.test/ws'),
    );
    // Identity admission is covered by the socket tests; this fixture exercises transport projection only.
    closes.length = 0;
    return { hub, sent, closes, timers, clock };
  };

  test('an access expansion bypasses held replay and cancels the old guest expiry before resync', async () => {
    const { hub, sent, closes, timers, clock } = await rig();
    hub.restrictChannel?.('guest', channelId, {
      key: 'old-guest',
      expiresAt: clock.now().getTime() + 1000,
      accepts: () => Promise.resolve(true),
    });
    const expiry = timers.pending.at(-1);
    if (expiry === undefined) throw new Error('Missing expiry timer');
    hub.hold('guest');
    hub.deliver('guest', revision('held-old-revision'));
    const hint: ServerFrame = {
      event: 'WORKSPACE_UPDATED',
      data: { workspaceId: channelId, accessChanged: true },
      ts: 1,
    };
    hub.deliver('guest', hint);
    expect(sent).toEqual([hint]);
    expect(closes).toEqual([CLOSE_CODES.RESYNC]);
    expect(timers.cleared.length).toBeGreaterThan(0);
    expiry.fire();
    expect(sent).toEqual([hint]);
  });
  test('personal updates and PONG keep their causal order behind a pending channel projection', async () => {
    const { hub, sent, closes } = await rig();
    const allowed = Promise.withResolvers<boolean>();
    if (hub.restrictChannel === undefined)
      throw new Error('Canonical hub is missing its delivery gate');
    hub.restrictChannel('guest', channelId, {
      key: 'current-channel',
      expiresAt: null,
      accepts: () => allowed.promise,
    });
    const message = revision('held-before-personal');
    const personal: ServerFrame = {
      event: 'NOTIFICATIONS_UPDATED',
      data: { workspaceId: channelId },
      ts: 2,
    };
    const pong: ServerFrame = { event: 'PONG', data: {}, refId: channelId, ts: 3 };
    hub.deliver('guest', message);
    hub.deliver('guest', personal);
    hub.deliver('guest', pong);
    try {
      expect(sent).toHaveLength(0);
    } finally {
      allowed.resolve(true);
      await hub.settled();
    }
    expect(sent).toEqual([message, personal, pong]);
    expect(closes).toHaveLength(0);
  });

  test.each(['session', 'policy'] as const)(
    '%s end bypasses a pending projection and retires the ordered tail',
    async (kind) => {
      const { hub, sent, closes } = await rig();
      const allowed = Promise.withResolvers<boolean>();
      if (hub.restrictChannel === undefined)
        throw new Error('Canonical hub is missing its delivery gate');
      hub.restrictChannel('guest', channelId, {
        key: 'old-policy',
        expiresAt: null,
        accepts: () => allowed.promise,
      });
      hub.deliver('guest', revision('obsolete-projection'));
      hub.deliver('guest', {
        event: 'NOTIFICATIONS_UPDATED',
        data: { workspaceId: channelId },
        ts: 1,
      });
      const terminal: ServerFrame =
        kind === 'session'
          ? { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 2 }
          : {
              event: 'WORKSPACE_UPDATED',
              data: { workspaceId: channelId, accessChanged: true },
              ts: 2,
            };
      hub.deliver('guest', terminal);
      try {
        expect(sent).toEqual([terminal]);
        expect(closes).toEqual([
          kind === 'session' ? CLOSE_CODES.SESSION_ENDED : CLOSE_CODES.RESYNC,
        ]);
      } finally {
        allowed.resolve(true);
        await hub.settled();
      }
      expect(sent).toEqual([terminal]);
    },
  );

  test('an ordinary workspace update does not interrupt a restricted connection', async () => {
    const { hub, sent, closes, clock } = await rig();
    hub.restrictChannel?.('guest', channelId, {
      key: 'old-guest',
      expiresAt: clock.now().getTime() + 1000,
      accepts: () => Promise.resolve(true),
    });
    hub.deliver('guest', { event: 'WORKSPACE_UPDATED', data: { workspaceId: channelId }, ts: 1 });
    expect(sent).toHaveLength(1);
    expect(closes).toEqual([]);
  });
  test('live and held revisions pass the subscription policy, while the acknowledgement stays first', async () => {
    const { hub, sent } = await rig();
    hub.hold('guest');
    hub.deliver('guest', revision('earlier'));
    hub.restrictChannel?.('guest', channelId, {
      key: 'grant',
      expiresAt: null,
      accepts: (frame) =>
        Promise.resolve(frame.event !== 'MESSAGE_REVISED' || frame.data.messageId !== 'earlier'),
    });
    hub.reply('guest', [{ event: 'ACK', data: { channels: [] }, ts: 2 }]);
    hub.deliver('guest', revision('later'));
    await hub.settled();
    expect(sent.map((frame) => frame.event)).toEqual(['ACK', 'MESSAGE_REVISED']);
    expect(sent.at(-1)).toEqual(revision('later'));
  });

  test('expiry refuses a frame even when the expiry timer has not fired', async () => {
    const { hub, sent, clock } = await rig();
    let attempted = 0;
    hub.restrictChannel?.('guest', channelId, {
      key: 'expiring',
      expiresAt: clock.now().getTime() + 1,
      accepts: () => {
        attempted += 1;
        return Promise.resolve(true);
      },
    });
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    hub.deliver('guest', revision('late'));
    await hub.settled();
    expect(sent.map((frame) => frame.event)).toEqual(['ACCESS_REVOKED']);
    expect(attempted).toBe(0);
  });

  test('a missed conversion hint rechecks once at the old deadline and resyncs without revoking drafts', async () => {
    const { hub, sent, closes, clock, timers } = await rig();
    const answer = Promise.withResolvers<boolean>();
    let checks = 0;
    let projected = 0;
    const expiry = {
      workspaceId: '11111111-1111-4111-8111-111111111112',
      recheck: (): Promise<boolean> => {
        checks += 1;
        return answer.promise;
      },
    };
    const other = '11111111-1111-4111-8111-111111111113';
    for (const id of [channelId, other])
      hub.restrictChannel?.('guest', id, {
        key: id,
        expiresAt: clock.now().getTime() + 1,
        expiry,
        accepts: () => {
          projected += 1;
          return Promise.resolve(true);
        },
      });
    const oldTimers = [...timers.pending];
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    hub.hold('guest');
    hub.deliver('guest', revision('deadline'));
    hub.deliver('guest', { event: 'PINS_UPDATED', data: { channelId: other }, ts: 1 });
    for (const timer of oldTimers) timer.fire();
    await Promise.resolve();
    expect(checks).toBe(1);
    expect(projected).toBe(0);
    expect(sent.length).toBe(0);
    let drained = false;
    const settling = hub.settled().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    answer.resolve(true);
    await settling;
    expect(sent).toEqual([
      {
        event: 'WORKSPACE_UPDATED',
        data: { workspaceId: expiry.workspaceId, accessChanged: true },
        ts: clock.now().getTime(),
      },
    ]);
    expect(closes).toEqual([CLOSE_CODES.RESYNC]);
    for (const timer of oldTimers) timer.fire();
    expect(sent.length).toBe(1);
  });

  test('a denied deadline revokes all expired scopes once and does not release held private output', async () => {
    const { hub, sent, closes, clock, timers } = await rig();
    let checks = 0;
    const other = '11111111-1111-4111-8111-111111111113';
    for (const id of [channelId, other])
      hub.restrictChannel?.('guest', id, {
        key: id,
        expiresAt: clock.now().getTime() + 1,
        expiry: {
          workspaceId: '11111111-1111-4111-8111-111111111112',
          recheck: () => {
            checks += 1;
            return Promise.resolve(false);
          },
        },
        accepts: () => Promise.resolve(true),
      });
    hub.hold('guest');
    hub.deliver('guest', revision('held-private-output'));
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    const deadline = timers.pending.at(-1);
    if (deadline === undefined) throw new Error('Missing guest deadline');
    deadline.fire();
    await hub.settled();
    expect(sent.length).toBe(0);
    hub.reply('guest', []);
    expect(sent).toEqual([
      {
        event: 'ACCESS_REVOKED',
        data: { channelIds: [channelId, other] },
        ts: clock.now().getTime(),
      },
    ]);
    expect(checks).toBe(1);
    expect(closes).toEqual([]);
  });

  test('an early guest timer rearms until the absolute deadline instead of losing the expiry', async () => {
    const { hub, sent, clock, timers } = await rig();
    let checks = 0;
    hub.restrictChannel?.('guest', channelId, {
      key: 'absolute-deadline',
      expiresAt: clock.now().getTime() + 1000,
      expiry: {
        workspaceId: '11111111-1111-4111-8111-111111111112',
        recheck: () => {
          checks += 1;
          return Promise.resolve(false);
        },
      },
      accepts: () => Promise.resolve(true),
    });
    const first = timers.pending.at(-1);
    if (first === undefined) throw new Error('Missing deadline timer');
    first.fire();
    expect(checks).toBe(0);
    expect(sent.length).toBe(0);
    const rearmed = timers.pending.at(-1);
    expect(rearmed === first).toBe(false);
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    rearmed?.fire();
    await hub.settled();
    expect(checks).toBe(1);
    expect(sent.map((frame) => frame.event)).toEqual(['ACCESS_REVOKED']);
  });

  test('membership denial also clears older future and unlimited scopes while another workspace stays usable', async () => {
    const { hub, sent, clock } = await rig();
    const answer = Promise.withResolvers<boolean>();
    const workspaceId = '11111111-1111-4111-8111-111111111112';
    const future = '11111111-1111-4111-8111-111111111113';
    const unlimited = '11111111-1111-4111-8111-111111111114';
    const elsewhere = '11111111-1111-4111-8111-111111111115';
    let projected = 0;
    for (const [id, expiresAt] of [
      [channelId, clock.now().getTime() + 1],
      [future, clock.now().getTime() + 60_000],
      [unlimited, null],
    ] as const)
      hub.restrictChannel?.('guest', id, {
        key: id,
        expiresAt,
        expiry: { workspaceId, recheck: () => answer.promise },
        accepts: () => {
          projected += 1;
          return Promise.resolve(true);
        },
      });
    hub.restrictChannel?.('guest', elsewhere, {
      key: 'elsewhere',
      expiresAt: null,
      expiry: { workspaceId: elsewhere, recheck: () => Promise.resolve(true) },
      accepts: () => Promise.resolve(true),
    });
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    hub.deliver('guest', revision('expired'));
    for (const id of [future, unlimited, elsewhere])
      hub.deliver('guest', { event: 'PINS_UPDATED', data: { channelId: id }, ts: 1 });
    // The healthy workspace's ordered projection is a positive barrier for this microtask queue.
    for (
      let turn = 0;
      turn < 50 &&
      !sent.some((frame) => frame.event === 'PINS_UPDATED' && frame.data.channelId === elsewhere);
      turn += 1
    )
      await Promise.resolve();
    expect(
      sent.some((frame) => frame.event === 'PINS_UPDATED' && frame.data.channelId === elsewhere),
    ).toBe(true);
    expect(projected).toBe(0);
    answer.resolve(false);
    await hub.settled();
    expect(sent).toEqual([
      { event: 'PINS_UPDATED', data: { channelId: elsewhere }, ts: 1 },
      {
        event: 'ACCESS_REVOKED',
        data: { channelIds: [channelId, future, unlimited] },
        ts: clock.now().getTime(),
      },
    ]);
  });

  test.each(['replaced', 'disconnected'] as const)(
    'a pending expiry result cannot act on a %s scope',
    async (change) => {
      const { hub, sent, closes, clock } = await rig();
      const answer = Promise.withResolvers<boolean>();
      hub.restrictChannel?.('guest', channelId, {
        key: 'former',
        expiresAt: clock.now().getTime() + 1,
        expiry: {
          workspaceId: '11111111-1111-4111-8111-111111111112',
          recheck: () => answer.promise,
        },
        accepts: () => Promise.resolve(true),
      });
      clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
      hub.deliver('guest', revision('not-delivered'));
      if (change === 'disconnected') hub.closed('guest');
      else
        hub.restrictChannel?.('guest', channelId, {
          key: 'replacement',
          expiresAt: null,
          accepts: () => Promise.resolve(true),
        });
      answer.resolve(false);
      await hub.settled();
      expect(sent.length).toBe(0);
      expect(closes).toEqual([]);
      if (change === 'replaced') {
        hub.deliver('guest', revision('new-scope'));
        await hub.settled();
        expect(sent).toEqual([revision('new-scope')]);
      }
    },
  );

  test('replacing the initiating channel still lets the check revoke the other expired scopes', async () => {
    const { hub, sent, clock } = await rig();
    const answer = Promise.withResolvers<boolean>();
    const other = '11111111-1111-4111-8111-111111111113';
    for (const id of [channelId, other])
      hub.restrictChannel?.('guest', id, {
        key: id,
        expiresAt: clock.now().getTime() + 1,
        expiry: {
          workspaceId: '11111111-1111-4111-8111-111111111112',
          recheck: () => answer.promise,
        },
        accepts: () => Promise.resolve(true),
      });
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    hub.deliver('guest', revision('old'));
    hub.restrictChannel?.('guest', channelId, {
      key: 'replacement',
      expiresAt: null,
      accepts: () => Promise.resolve(true),
    });
    answer.resolve(false);
    await hub.settled();
    expect(sent).toEqual([
      { event: 'ACCESS_REVOKED', data: { channelIds: [other] }, ts: clock.now().getTime() },
    ]);
    hub.deliver('guest', revision('replacement-still-works'));
    await hub.settled();
    expect(sent.at(-1)).toEqual(revision('replacement-still-works'));
  });

  test('a failed expiry lookup resyncs without treating an unavailable database as revocation', async () => {
    const { hub, sent, closes, clock } = await rig();
    hub.restrictChannel?.('guest', channelId, {
      key: 'unavailable',
      expiresAt: clock.now().getTime() + 1,
      expiry: {
        workspaceId: '11111111-1111-4111-8111-111111111112',
        recheck: () => Promise.reject(new Error('Database unavailable')),
      },
      accepts: () => Promise.resolve(true),
    });
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    hub.deliver('guest', revision('not-delivered'));
    await hub.settled();
    expect(sent.length).toBe(0);
    expect(closes).toEqual([CLOSE_CODES.RESYNC]);
  });

  test('a completed check cannot send an old workspace hint to a replacement connection', async () => {
    const { hub, sent, clock } = await rig();
    const answer = Promise.withResolvers<boolean>();
    hub.restrictChannel?.('guest', channelId, {
      key: 'former-connection',
      expiresAt: clock.now().getTime() + 1,
      expiry: {
        workspaceId: '11111111-1111-4111-8111-111111111112',
        recheck: () => answer.promise,
      },
      accepts: () => Promise.resolve(true),
    });
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    hub.deliver('guest', revision('not-delivered'));
    hub.closed('guest');
    const replacement: ServerFrame[] = [];
    const closes: number[] = [];
    await hub.opened(
      'guest',
      {
        send: (payload) => {
          replacement.push(JSON.parse(payload) as ServerFrame);
          return payload.length;
        },
        buffered: () => 0,
        close: (code) => {
          closes.push(code);
        },
      },
      new Request('https://purlay.test/ws'),
    );
    closes.length = 0;
    answer.resolve(true);
    await hub.settled();
    expect(sent.length).toBe(0);
    expect(replacement.length).toBe(0);
    expect(closes).toEqual([]);
  });

  test('one recheck splits a large expired scope into valid bounded revocations', async () => {
    const { hub, sent, clock } = await rig();
    let checks = 0;
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    for (const id of ids)
      hub.restrictChannel?.('guest', id, {
        key: id,
        expiresAt: clock.now().getTime() + 1,
        expiry: {
          workspaceId: '11111111-1111-4111-8111-111111111112',
          recheck: () => {
            checks += 1;
            return Promise.resolve(false);
          },
        },
        accepts: () => Promise.resolve(true),
      });
    const first = ids[0];
    if (first === undefined) throw new Error('No restricted scope');
    clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
    hub.deliver('guest', { event: 'PINS_UPDATED', data: { channelId: first }, ts: 1 });
    await hub.settled();
    const revoked = sent.flatMap((frame) =>
      frame.event === 'ACCESS_REVOKED' ? [frame.data.channelIds] : [],
    );
    expect(revoked.map((group) => group.length)).toEqual([500, 1]);
    expect(revoked.flat()).toEqual(ids);
    expect(checks).toBe(1);
  });

  test(
    'a stalled expiry check is aborted at the unchanged request deadline and resyncs',
    async () => {
      const { hub, sent, closes, clock } = await rig();
      let seen: AbortSignal | undefined;
      hub.restrictChannel?.('guest', channelId, {
        key: 'stalled',
        expiresAt: clock.now().getTime() + 1,
        expiry: {
          workspaceId: '11111111-1111-4111-8111-111111111112',
          recheck: (signal) => {
            seen = signal;
            return new Promise<boolean>(() => undefined);
          },
        },
        accepts: () => Promise.resolve(true),
      });
      clock.now = (): Date => new Date('2026-11-10T00:00:01Z');
      hub.deliver('guest', revision('stalled'));
      await hub.settled();
      expect(seen?.aborted).toBe(true);
      expect(sent.length).toBe(0);
      expect(closes).toEqual([CLOSE_CODES.RESYNC]);
    },
    // Exercise the real production deadline: the test must live long enough to observe it.
    DEFAULT_DEADLINE_MS + 5_000,
  );

  test('revocation drops an authorization result that was already waiting', async () => {
    const { hub, sent } = await rig();
    let finish: (value: boolean) => void = () => {
      throw new Error('Policy did not start');
    };
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    hub.restrictChannel?.('guest', channelId, {
      key: 'grant',
      expiresAt: null,
      accepts: async () => await pending,
    });
    hub.deliver('guest', revision('pending'));
    await Promise.resolve();
    hub.deliver('guest', { event: 'ACCESS_REVOKED', data: { channelIds: [channelId] }, ts: 2 });
    finish(true);
    await hub.settled();
    expect(sent.map((frame) => frame.event)).toEqual(['ACCESS_REVOKED']);
  });

  test.each(['revoked', 'resync'] as const)(
    'a current %s verdict sends only its control action, never the original words',
    async (verdict) => {
      const { hub, sent, closes } = await rig();
      const workspaceId = '11111111-1111-4111-8111-111111111112';
      hub.restrictChannel?.('guest', channelId, {
        key: 'grant',
        expiresAt: null,
        expiry: { workspaceId, recheck: () => Promise.resolve(true) },
        accepts: () => Promise.resolve(verdict),
      });
      hub.deliver('guest', revision('never these words'));
      await hub.settled();
      expect(sent.map((frame) => frame.event)).toEqual([
        verdict === 'revoked' ? 'ACCESS_REVOKED' : 'WORKSPACE_UPDATED',
      ]);
      expect(closes).toEqual(verdict === 'resync' ? [CLOSE_CODES.RESYNC] : []);
    },
  );

  test('a changed policy without workspace metadata still closes rather than exposing words', async () => {
    const { hub, sent, closes } = await rig();
    hub.restrictChannel?.('guest', channelId, {
      key: 'grant',
      expiresAt: null,
      accepts: () => Promise.resolve('resync'),
    });
    hub.deliver('guest', revision('never these words'));
    await hub.settled();
    expect(sent.length).toBe(0);
    expect(closes).toEqual([CLOSE_CODES.RESYNC]);
  });

  test('a failed policy closes to resynchronize without exposing the frame', async () => {
    const { hub, sent, closes } = await rig();
    hub.restrictChannel?.('guest', channelId, {
      key: 'grant',
      expiresAt: null,
      accepts: () => Promise.reject(new Error('Metadata read unavailable')),
    });
    hub.deliver('guest', revision('unreadable'));
    await hub.settled();
    expect(sent).toEqual([]);
    expect(closes).toEqual([CLOSE_CODES.RESYNC]);
  });

  test('an unchanged resubscription keeps an already waiting frame in order', async () => {
    const { hub, sent } = await rig();
    let finish: (value: boolean) => void = () => {
      throw new Error('Missing pending projection');
    };
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    hub.restrictChannel?.('guest', channelId, {
      key: 'same-grant',
      expiresAt: null,
      accepts: async () => await pending,
    });
    hub.deliver('guest', revision('first'));
    await Promise.resolve();
    hub.restrictChannel?.('guest', channelId, {
      key: 'same-grant',
      expiresAt: null,
      accepts: () => Promise.resolve(true),
    });
    hub.deliver('guest', revision('second'));
    finish(true);
    await hub.settled();
    expect(
      sent.map((frame) => (frame.event === 'MESSAGE_REVISED' ? frame.data.messageId : frame.event)),
    ).toEqual(['first', 'second']);
  });

  test('expiry is checked again after a slow projection and timers are cleared on disconnect', async () => {
    const { hub, sent, clock, timers } = await rig();
    let finish: (value: boolean) => void = () => {
      throw new Error('Missing pending projection');
    };
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    hub.restrictChannel?.('guest', channelId, {
      key: 'expires',
      expiresAt: clock.now().getTime() + 1_000,
      accepts: async () => await pending,
    });
    hub.deliver('guest', revision('waiting'));
    await Promise.resolve();
    clock.now = (): Date => new Date('2026-11-10T00:00:02Z');
    finish(true);
    await hub.settled();
    expect(sent.map((frame) => frame.event)).toEqual(['ACCESS_REVOKED']);
    expect(timers.cleared).toHaveLength(1);
    hub.restrictChannel?.('guest', channelId, {
      key: 'later-grant',
      expiresAt: clock.now().getTime() + 1_000,
      accepts: () => Promise.resolve(true),
    });
    hub.closed('guest');
    expect(timers.cleared).toHaveLength(2);
    timers.pending.at(-1)?.fire();
    expect(sent.map((frame) => frame.event)).toEqual(['ACCESS_REVOKED']);
  });

  test('pending projections share the transport byte budget', async () => {
    const { hub, sent, closes } = await rig();
    hub.restrictChannel?.('guest', channelId, {
      key: 'grant',
      expiresAt: null,
      accepts: () => Promise.resolve(true),
    });
    for (let index = 0; index < 300; index += 1)
      hub.deliver('guest', revision(String(index), 'x'.repeat(20_000)));
    await hub.settled();
    expect(sent).toEqual([]);
    expect(closes.every((code) => code === CLOSE_CODES.RESYNC)).toBe(true);
    expect(closes.length).toBeGreaterThan(0);
  });
});

describe('a timer longer than a JavaScript timer allows', () => {
  test('is chained in links the runtime honours, and fires once, at the end', () => {
    const timers = recordedTimers();
    let fired = 0;
    after(timers, 30 * DAY, () => {
      fired += 1;
    });

    expect(timers.pending.map((t) => t.ms)).toEqual([MAX_TIMER_MS]);
    timers.pending[0]?.fire();
    expect(fired).toBe(0);
    expect(timers.pending.map((t) => t.ms)).toEqual([MAX_TIMER_MS, 30 * DAY - MAX_TIMER_MS]);
    timers.pending[1]?.fire();
    expect(fired).toBe(1);
  });

  test('a short one is a single timer, and a past one fires as soon as it can', () => {
    const timers = recordedTimers();
    after(timers, 500, () => undefined);
    after(timers, -5_000, () => undefined);
    expect(timers.pending.map((t) => t.ms)).toEqual([500, 0]);
  });

  test('cancelling clears whichever link is pending', () => {
    const timers = recordedTimers();
    const cancel = after(timers, 30 * DAY, () => undefined);
    timers.pending[0]?.fire();
    cancel();
    expect(timers.cleared).toEqual([2]);
  });
});

describe('the end of a session, on a connection', () => {
  test('is announced, then the connection is closed with the code that says why', () => {
    const hub = createSocketHub(
      anAuthThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined, listen: () => undefined },
    );
    const events: string[] = [];
    // Registered without resolving an identity: delivery does not depend on one.
    void hub
      .opened(
        'socket-1',
        {
          send: (payload) => events.push(`send ${payload}`),
          buffered: () => 0,
          close: (code, reason) => events.push(`close ${String(code)} ${reason}`),
        },
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);

    hub.deliver('socket-1', { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 0 });
    expect(events).toEqual([
      'send {"event":"SESSION_ENDED","data":{"reason":"signed-out"},"ts":0}',
      `close ${String(CLOSE_CODES.SESSION_ENDED)} signed-out`,
    ]);
  });
});

describe('the end of a session, heard twice', () => {
  test('is said once and closed once: the topic and the opening read may both learn it (#577)', () => {
    const hub = createSocketHub(
      anAuthThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined, listen: () => undefined },
    );
    const events: string[] = [];
    void hub
      .opened(
        'socket-1',
        {
          send: (payload) => events.push(`send ${payload}`),
          buffered: () => 0,
          close: (code) => events.push(`close ${String(code)}`),
        },
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);
    const ended = { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 0 } as const;
    hub.deliver('socket-1', ended);
    hub.deliver('socket-1', { ...ended, data: { reason: 'expired' } });
    expect(events).toEqual([
      `send ${JSON.stringify(ended)}`,
      `close ${String(CLOSE_CODES.SESSION_ENDED)}`,
    ]);
  });
});

describe('a connection that falls behind (#197)', () => {
  const connectionWith = (
    written: number,
    buffered: number,
  ): { connection: Connection; closes: string[] } => {
    const closes: string[] = [];
    return {
      closes,
      connection: {
        send: () => written,
        buffered: () => buffered,
        close: (code: number, reason: string): void => {
          closes.push(`${String(code)} ${reason}`);
        },
      },
    };
  };

  const deliverTo = (connection: Connection): void => {
    const hub = createSocketHub(
      anAuthThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined, listen: () => undefined },
    );
    void hub.opened('s', connection, new Request('https://purlay.test/ws')).catch(() => undefined);
    hub.deliver('s', { event: 'PONG', data: {}, ts: 0 });
  };

  test('a frame the transport dropped closes the connection to resync', () => {
    const { connection, closes } = connectionWith(0, 0);
    deliverTo(connection);
    expect(closes).toEqual([`${String(CLOSE_CODES.RESYNC)} resync`]);
  });

  test('a queue past the mark closes it; one at the mark does not', () => {
    const over = connectionWith(-1, OUTBOUND_HIGH_WATER_MARK + 1);
    deliverTo(over.connection);
    expect(over.closes).toEqual([`${String(CLOSE_CODES.RESYNC)} resync`]);

    const at = connectionWith(-1, OUTBOUND_HIGH_WATER_MARK);
    deliverTo(at.connection);
    expect(at.closes).toEqual([]);
  });

  /**
   * A healthy reader receives a replay as one burst. If the mark were below it,
   * the reader would be closed by its own replay, reconnect, replay again, and
   * loop. A loopback socket drains too fast to show that, so the relation itself
   * is the test.
   */
  test('the mark exceeds the largest burst a healthy connection is sent', () => {
    expect(OUTBOUND_HIGH_WATER_MARK).toBeGreaterThan(REPLAY_BYTES_MAX + MAX_FRAME_BYTES);
  });
});

describe('live frames held while a subscription replays', () => {
  const rig = (): { hub: ReturnType<typeof createSocketHub>; events: string[] } => {
    const hub = createSocketHub(
      anAuthThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined, listen: () => undefined },
    );
    const events: string[] = [];
    void hub
      .opened(
        's',
        {
          send: (payload) =>
            events.push(`send ${(JSON.parse(payload) as { event: string }).event}`),
          buffered: () => 0,
          close: (code) => events.push(`close ${String(code)}`),
        },
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);
    return { hub, events };
  };

  test('nothing is written until the reply, which goes first', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.deliver('s', { event: 'PONG', data: {}, ts: 1 });
    expect(events).toEqual([]);
    hub.reply('s', [{ event: 'ACK', data: { channels: [] }, ts: 2 }]);
    expect(events).toEqual(['send ACK', 'send PONG']);
  });

  test('after the reply, delivery is direct again', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.reply('s', []);
    hub.deliver('s', { event: 'PONG', data: {}, ts: 1 });
    expect(events).toEqual(['send PONG']);
  });

  test('the end of a session is not kept waiting', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.deliver('s', { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 1 });
    expect(events).toEqual(['send SESSION_ENDED', `close ${String(CLOSE_CODES.SESSION_ENDED)}`]);
  });

  test('a connection outrun by its own replay is closed to resync, not grown without limit', () => {
    const { hub, events } = rig();
    hub.hold('s');
    for (let i = 0; i <= HELD_FRAMES_MAX; i += 1) {
      hub.deliver('s', { event: 'PONG', data: {}, ts: i });
    }
    expect(events).toEqual([`close ${String(CLOSE_CODES.RESYNC)}`]);
  });

  test('a closed connection keeps nothing', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.closed('s');
    hub.deliver('s', { event: 'PONG', data: {}, ts: 1 });
    hub.reply('s', [{ event: 'PONG', data: {}, ts: 2 }]);
    expect(events).toEqual([]);
    expect(hub.isOpen('s')).toBe(false);
  });
});

describe('the events of a module this process does not run', () => {
  const sentTo = (closedEvent: ((event: string) => boolean) | undefined): string[] => {
    const hub = createSocketHub(
      anAuthThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      {
        log: createLogger({ level: 'silent' }),
        leave: () => undefined,
        listen: () => undefined,
        ...(closedEvent === undefined ? {} : { closedEvent }),
      },
    );
    const events: string[] = [];
    void hub
      .opened(
        's',
        {
          send: (payload) => events.push((JSON.parse(payload) as { event: string }).event),
          buffered: () => 0,
          close: () => undefined,
        },
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);
    // Another node that runs the module may have published both: the hub is where this node's own list is held to.
    hub.deliver('s', { event: 'PONG', data: {}, ts: 1 });
    hub.deliver('s', { event: 'ACK', data: { channels: [] }, ts: 2 });
    return events;
  };

  test('are dropped at delivery, and the rest of what is delivered is written', () => {
    expect(sentTo((event) => event === 'PONG')).toEqual(['ACK']);
  });

  test('are all written where no event is closed', () => {
    expect(sentTo(undefined)).toEqual(['PONG', 'ACK']);
    expect(sentTo(() => false)).toEqual(['PONG', 'ACK']);
  });
});

describe('a connection with no identity', () => {
  test('is told its session has ended and is closed, with nothing armed for it', async () => {
    const hub = createSocketHub(
      anAuthThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined, listen: () => undefined },
    );
    const closes: string[] = [];
    // No cookie: nothing to look up, so the database is not reached.
    const identity = await hub.opened(
      's',
      {
        send: () => 0,
        buffered: () => 0,
        close: (code, reason) => closes.push(`${String(code)} ${reason}`),
      },
      new Request('https://purlay.test/ws'),
    );
    expect(identity).toBeUndefined();
    expect(closes).toEqual([`${String(CLOSE_CODES.SESSION_ENDED)} signed-out`]);
  });
});

describe('the frames of one connection, in turn', () => {
  const rig = (): {
    hub: ReturnType<typeof createSocketHub>;
    closes: string[];
  } => {
    const hub = createSocketHub(
      anAuthThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined, listen: () => undefined },
    );
    const closes: string[] = [];
    void hub
      .opened(
        's',
        {
          send: () => 0,
          buffered: () => 0,
          close: (code) => closes.push(String(code)),
        },
        // No cookie: the connection is closed as signed out, which the tests ignore.
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);
    return { hub, closes };
  };

  const gate = (): { open: () => void; wait: Promise<void> } => {
    let open = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, wait };
  };

  test('a frame does not start until the one before it has finished, however slow', async () => {
    const { hub } = rig();
    const events: string[] = [];
    const slow = gate();
    hub.enqueue('s', async () => {
      events.push('first starts');
      await slow.wait;
      events.push('first ends');
    });
    hub.enqueue('s', async () => {
      events.push('second runs');
      await Promise.resolve();
    });
    await Bun.sleep(5);
    expect(events).toEqual(['first starts']);
    slow.open();
    await hub.settled();
    expect(events).toEqual(['first starts', 'first ends', 'second runs']);
  });

  test('a frame that fails does not stop the ones behind it', async () => {
    const { hub } = rig();
    const ran: string[] = [];
    hub.enqueue('s', async () => {
      await Promise.reject(new Error('one failed'));
    });
    hub.enqueue('s', async () => {
      ran.push('second');
      await Promise.resolve();
    });
    await hub.settled();
    expect(ran).toEqual(['second']);
  });

  test('work still queued when the connection closes never runs', async () => {
    const { hub } = rig();
    const ran: string[] = [];
    const slow = gate();
    hub.enqueue('s', async () => {
      await slow.wait;
    });
    hub.enqueue('s', async () => {
      ran.push('late');
      await Promise.resolve();
    });
    hub.closed('s');
    slow.open();
    await hub.settled();
    expect(ran).toEqual([]);
    // And a frame for a connection that has gone is dropped, not queued.
    hub.enqueue('s', async () => {
      ran.push('after');
      await Promise.resolve();
    });
    await hub.settled();
    expect(ran).toEqual([]);
  });

  test('a queue past its bound closes the connection, TOO_BUSY, and drops what was queued', async () => {
    const { hub, closes } = rig();
    const ran: number[] = [];
    const slow = gate();
    for (let i = 0; i < FRAME_QUEUE_MAX; i += 1) {
      hub.enqueue('s', async () => {
        ran.push(i);
        await slow.wait;
      });
    }
    // The first frame is under way; the other thirty-one wait behind it.
    await Bun.sleep(1);
    // The control: at the bound, nothing is refused yet.
    expect(closes.includes(String(CLOSE_CODES.TOO_BUSY))).toBe(false);
    hub.enqueue('s', async () => {
      await Promise.resolve();
    });
    expect(closes.includes(String(CLOSE_CODES.TOO_BUSY))).toBe(true);
    slow.open();
    await hub.settled();
    // Only the frame already being handled finished; the rest were dropped.
    expect(ran).toEqual([0]);
  });

  test('settled waits for work in flight, and is immediate with none', async () => {
    const { hub } = rig();
    await hub.settled();
    let finished = false;
    const slow = gate();
    hub.enqueue('s', async () => {
      await slow.wait;
      finished = true;
    });
    const waiting = hub.settled().then(() => finished);
    slow.open();
    expect(await waiting).toBe(true);
  });
});
