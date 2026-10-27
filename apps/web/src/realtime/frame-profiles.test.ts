/**
 * What the real client puts on the wire, in the cases that decide the frame budget (O-4, D-198).
 *
 * The server's budget is per connection (`SOCKET_FRAME_BUDGET`, ten frames a second, a burst of
 * twenty); what it must hold is what a person's page sends. This drives the real engine and
 * connection — a person typing, sending, switching channels, coming back from a gap — against a
 * socket and a clock moved by hand, and measures each profile: the frames, the most in any one
 * second, the most at one instant. `apps/api/src/realtime/frame-profiles.ts` holds the other half,
 * the same profiles through the real limiter; what it assumes of the client is what is pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import {
  CLOSE_CODES,
  OUTBOX_MAX_MESSAGES,
  SUBSCRIBE_MAX_CHANNELS,
  TYPING_TTL_MS,
  type ServerFrame,
} from '@purlay/types';
import { ApiError } from '../data/errors';
import { anApi } from '../testing/fake-api';
import { fakeSchedule } from '../testing/fakes';
import type { Api } from '../data/api';
import type { SocketHandlers } from './connection';
import { createEngine, type Engine } from './engine';

/** The clock moves in steps this size, so a timer is never missed by more than one. */
const STEP_MS = 5;
const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const ME = '00000000-0000-4000-8000-0000000000e1';
const channelId = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CH = channelId(0xc1);

interface Sent {
  readonly at: number;
  readonly op: string;
  readonly id: string;
  readonly channels: number;
}

/** One page: an engine, its socket, and a clock that moves only when told. */
interface Tab {
  readonly engine: Engine;
  /** Every frame the page sent, with the time it left. */
  readonly sent: Sent[];
  readonly sockets: { readonly handlers: SocketHandlers }[];
  readonly tick: (ms: number) => void;
  readonly now: () => number;
  /** Opens the newest socket. */
  readonly open: () => void;
  readonly deliver: (frame: ServerFrame) => void;
}

const aTab = (api: Partial<Api> = {}, roundTripMs = 20): Tab => {
  const timers = fakeSchedule();
  let at = 0;
  const sent: Sent[] = [];
  const sockets: { handlers: SocketHandlers }[] = [];
  const engine = createEngine({
    api: anApi(api),
    client: new QueryClient(),
    userId: ME,
    url: 'ws://purlay.test/ws',
    openSocket: (_url, handlers) => {
      sockets.push({ handlers });
      return {
        send: (text): void => {
          const parsed = JSON.parse(text) as {
            id: string;
            op: string;
            payload: { channels?: unknown[]; channelIds?: unknown[] };
          };
          sent.push({
            at,
            op: parsed.op,
            id: parsed.id,
            channels: (parsed.payload.channels ?? parsed.payload.channelIds ?? []).length,
          });
        },
        close: (): void => undefined,
      };
    },
    schedule: timers.schedule,
    random: () => 0.5,
    clock: { now: () => new Date(T0 + at) },
    onSessionEnded: () => undefined,
  });
  const answered = new Set<string>();
  const last = (): { handlers: SocketHandlers } => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  };
  return {
    engine,
    sent,
    sockets,
    tick: (ms): void => {
      for (let moved = 0; moved < ms; moved += STEP_MS) {
        at += STEP_MS;
        timers.advance(STEP_MS);
        // A server that is alive: it answers a ping at once and a subscription a round trip later.
        for (const frame of sent) {
          if (answered.has(frame.id)) continue;
          if (frame.op === 'PING' && sockets.length > 0) {
            answered.add(frame.id);
            last().handlers.message(
              JSON.stringify({ event: 'ACK', refId: frame.id, ts: T0, data: { id: frame.id } }),
            );
          } else if (frame.op === 'SUBSCRIBE' && at >= frame.at + roundTripMs) {
            answered.add(frame.id);
            last().handlers.message(JSON.stringify(acknowledged(frame.id, frame.channels, 1)));
          }
        }
      }
    },
    now: (): number => at,
    open: (): void => {
      last().handlers.opened();
    },
    deliver: (frame): void => {
      last().handlers.message(JSON.stringify(frame));
    },
  };
};

/** The most frames in any window of one second, and the most at one instant. */
const measure = (
  frames: readonly Sent[],
): { readonly frames: number; readonly peakPerSecond: number; readonly burst: number } => {
  let peak = 0;
  let burst = 0;
  frames.forEach((frame, index) => {
    const inWindow = frames.filter((other) => other.at >= frame.at && other.at < frame.at + 1000);
    peak = Math.max(peak, inWindow.length);
    burst = Math.max(burst, frames.slice(index).filter((other) => other.at === frame.at).length);
  });
  return { frames: frames.length, peakPerSecond: peak, burst };
};

const ofOp = (tab: Tab, ...ops: string[]): Sent[] => tab.sent.filter((s) => ops.includes(s.op));

/** What the server says to a SUBSCRIBE it takes. */
const acknowledged = (chunkId: string, count: number, first: number): ServerFrame => ({
  event: 'ACK',
  refId: chunkId,
  ts: T0,
  data: {
    channels: Array.from({ length: count }, (_, n) => ({
      channelId: channelId(first + n),
      nextCursor: null,
    })),
  },
});

/** A page that has loaded: socket open, nothing sent yet but the subscription. */
const loaded = (api: Partial<Api> = {}): Tab => {
  const tab = aTab(api);
  tab.engine.start();
  tab.open();
  return tab;
};

describe('typing', () => {
  test('the fastest typist announces once per half of the time a announcement holds, however many keys', () => {
    const tab = loaded();
    // Seventeen keys a second is past any person; the keystroke path calls announceTyping every time.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 60) {
      tab.engine.announceTyping(CH);
      tab.tick(60);
    }
    const typing = ofOp(tab, 'TYPING');
    expect(typing).toHaveLength(60_000 / (TYPING_TTL_MS / 2));
    expect(measure(typing)).toMatchObject({ peakPerSecond: 1, burst: 1 });
  });

  test('a short message every second is a typing frame and a send, two frames a second', () => {
    const tab = loaded();
    for (let second = 0; second < 30; second += 1) {
      for (let key = 0; key < 8; key += 1) {
        tab.engine.announceTyping(CH);
        tab.tick(100);
      }
      tab.engine.send({ channelId: CH, content: 'ok' });
      tab.tick(200);
    }
    const frames = ofOp(tab, 'TYPING', 'MESSAGE_SEND');
    expect(frames).toHaveLength(60);
    expect(measure(frames)).toMatchObject({ peakPerSecond: 2, burst: 1 });
  });

  test('a paste is one typing frame and one send: its size is one frame, never many', () => {
    const tab = loaded();
    tab.engine.announceTyping(CH);
    tab.engine.send({ channelId: CH, content: 'x'.repeat(8_000) });
    expect(measure(ofOp(tab, 'TYPING', 'MESSAGE_SEND'))).toMatchObject({ frames: 2, burst: 2 });
  });
});

describe('switching channels', () => {
  const all = Array.from({ length: 60 }, (_, n) => channelId(n + 1));

  test('costs no frame: the page is subscribed to every channel it is in, whichever is on screen', () => {
    const tab = loaded();
    tab.engine.watch(all);
    tab.tick(100);
    const before = tab.sent.length;
    // Eight switches a second for ten seconds: each is the same list of channels again.
    for (let n = 0; n < 80; n += 1) {
      tab.engine.watch(all);
      tab.tick(125);
    }
    expect(tab.sent.length).toBe(before);
  });

  test('with a keystroke in each new channel, costs one typing frame per key, at the pace of the switching, and no more', () => {
    const tab = loaded();
    tab.engine.watch(all);
    tab.tick(100);
    // Four channels a second, one key in each, round the whole list twice.
    for (let n = 0; n < 120; n += 1) {
      tab.engine.announceTyping(all[n % all.length] ?? CH);
      tab.tick(250);
    }
    const typing = ofOp(tab, 'TYPING');
    // A round of sixty takes fifteen seconds, longer than a channel is held, so every key is news.
    expect(typing).toHaveLength(120);
    expect(measure(typing)).toMatchObject({ peakPerSecond: 4, burst: 1 });
  });
});

describe('coming back from a gap', () => {
  test.each([
    [100, 20, 1],
    [1_000, 20, 10],
    [3_500, 20, 35],
    [3_500, 150, 35],
  ] as const)(
    '%i channels, a round trip of %i ms: %i frames, one chunk in flight at a time',
    (total, roundTripMs, chunks) => {
      const tab = aTab({}, roundTripMs);
      tab.engine.watch(Array.from({ length: total }, (_, n) => channelId(n + 1)));
      tab.engine.start();
      tab.open();
      tab.tick(60_000);
      const subscribes = ofOp(tab, 'SUBSCRIBE');
      expect(subscribes).toHaveLength(chunks);
      expect(subscribes.every((s) => s.channels <= SUBSCRIBE_MAX_CHANNELS)).toBe(true);
      // Never two at one instant: the next waits for the answer to the last.
      expect(measure(subscribes).burst).toBe(1);
      for (let n = 1; n < subscribes.length; n += 1) {
        expect((subscribes[n]?.at ?? 0) - (subscribes[n - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
          roundTripMs,
        );
      }
    },
  );

  test('a full outbox goes out in one instant, ahead of any answer: the burst a person may send after a long disconnect', () => {
    const tab = aTab({ send: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')) });
    tab.engine.start();
    tab.open();
    tab.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    for (let n = 0; n < OUTBOX_MAX_MESSAGES; n += 1) {
      tab.engine.send({ channelId: CH, content: `offline ${String(n)}` });
    }
    const before = tab.sockets.length;
    for (let waited = 0; tab.sockets.length === before && waited < 60_000; waited += 100) {
      tab.tick(100);
    }
    const sentBefore = tab.sent.length;
    tab.open();
    const afterOpen = tab.sent.slice(sentBefore);
    expect(afterOpen.filter((s) => s.op === 'MESSAGE_SEND')).toHaveLength(OUTBOX_MAX_MESSAGES);
    expect(measure(afterOpen).burst).toBe(afterOpen.length);
    expect(afterOpen.length).toBeLessThanOrEqual(OUTBOX_MAX_MESSAGES + 2);
  });
});

describe('several pages', () => {
  test('each tab is its own connection, so its own frames and nothing of another tab', () => {
    const tabs = Array.from({ length: 5 }, () => loaded());
    for (const tab of tabs) {
      for (let elapsed = 0; elapsed < 30_000; elapsed += 60) {
        tab.engine.announceTyping(CH);
        tab.tick(60);
      }
    }
    for (const tab of tabs) expect(measure(ofOp(tab, 'TYPING')).peakPerSecond).toBe(1);
  });
});
