/**
 * The frame budget, measured without waiting for a team (O-4, D-198).
 *
 * Each profile is what one page puts on the wire in a case that could meet the budget — the fastest
 * typist, a message a second, a paste, switching channels, coming back from a gap with a thousand
 * channels or a full outbox, several tabs — as the frames and the instants they leave. They run through
 * the limiter the server runs (`inProcessRateLimiter`, per connection, and the user's write bucket a
 * send is also charged to) and come out as the most frames in a second, the most at one instant, and
 * what was refused.
 *
 * What a profile assumes of the client is pinned from the other side, against the real engine and
 * connection: `apps/web/src/realtime/frame-profiles.test.ts`. What is used here is the constants the
 * client reads (`TYPING_TTL_MS`, `ACTIVE_EVERY_MS`, `SUBSCRIBE_MAX_CHANNELS`, `OUTBOX_MAX_MESSAGES`,
 * `BACKOFF`), not copies of them.
 *
 *   bun run measure:frames
 */
import {
  ACTIVE_EVERY_MS,
  BACKOFF,
  OUTBOX_MAX_MESSAGES,
  PING_AFTER_IDLE_MS,
  SUBSCRIBE_MAX_CHANNELS,
  TYPING_TTL_MS,
} from '@purlay/types';
import type { Clock } from '../platform/clock';
import { inProcessRateLimiter, type RateBudget, type RateLimiter } from './rate-limiter';

type Op = 'TYPING' | 'MESSAGE_SEND' | 'SUBSCRIBE' | 'PING' | 'ACTIVE';

interface Frame {
  readonly at: number;
  readonly op: Op;
}

export interface Profile {
  readonly name: string;
  /** One connection's frames, in the order they left. */
  readonly frames: readonly Frame[];
  /** Whether a refusal would be a person using the product, refused. The flood is the one that is not. */
  readonly legitimate: boolean;
}

export interface Measured {
  readonly name: string;
  readonly legitimate: boolean;
  readonly frames: number;
  /** The most frames in any window of one second. */
  readonly peakPerSecond: number;
  /** The most frames at one instant. */
  readonly burst: number;
  /** Frames the connection's bucket refused, and sends the user's write bucket refused. */
  readonly refused: number;
  readonly writesRefused: number;
}

const MINUTE_MS = 60_000;

const clockAt = (): Clock & { readonly set: (time: number) => void } => {
  let time = 0;
  return {
    now: (): Date => new Date(time),
    set: (next): void => {
      time = next;
    },
  };
};

const times = (stepMs: number, forMs: number): number[] =>
  Array.from({ length: Math.ceil(forMs / stepMs) }, (_, n) => n * stepMs);
const frames = (op: Op, at: readonly number[]): Frame[] => at.map((time) => ({ at: time, op }));
const together = (op: Op, count: number, time: number): Frame[] =>
  frames(op, Array<number>(count).fill(time));
const inOrder = (all: readonly Frame[]): Frame[] => [...all].sort((a, b) => a.at - b.at);

/** A page's own upkeep: a ping after each idle spell, and the word that it is in front. */
const upkeep = (forMs: number): Frame[] => [
  ...frames('ACTIVE', times(ACTIVE_EVERY_MS, forMs)),
  ...frames('PING', times(PING_AFTER_IDLE_MS, forMs)),
];

/**
 * A subscription of `total` channels, a chunk at a time and the next only after the last is answered
 * (`connection.ts`, D-82). The server's answer is one round trip away; a chunk refused for the budget is
 * sent again after the backoff's wait, doubling to its cap, and the wait's jitter is left out.
 */
const resubscribe = async (
  total: number,
  roundTripMs: number,
  budget: RateBudget,
): Promise<Frame[]> => {
  const clock = clockAt();
  const limiter = inProcessRateLimiter(clock, budget);
  const sent: Frame[] = [];
  let remaining = Math.ceil(total / SUBSCRIBE_MAX_CHANNELS);
  let now = 0;
  let refusals = 0;
  while (remaining > 0 && sent.length < 100_000) {
    clock.set(now);
    sent.push({ at: now, op: 'SUBSCRIBE' });
    if (await limiter.consume('connection')) {
      remaining -= 1;
      refusals = 0;
      now += roundTripMs;
    } else {
      now += roundTripMs + Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** refusals);
      refusals += 1;
    }
  }
  return sent;
};

/** Every profile, for the budget it is to be run against (a refused chunk is sent again, so it depends). */
export const profiles = async (budget: RateBudget): Promise<readonly Profile[]> => {
  const legit = (name: string, all: readonly Frame[]): Profile => ({
    name,
    frames: inOrder(all),
    legitimate: true,
  });
  const out: Profile[] = [
    // Seventeen keys a second is past any person; the client says it once per half of `TYPING_TTL_MS`.
    legit('fastest typing, one channel, 5 min', [
      ...frames('TYPING', times(TYPING_TTL_MS / 2, 5 * MINUTE_MS)),
      ...upkeep(5 * MINUTE_MS),
    ]),
    // Eight keys, then Enter, every second: the send resets what was said, so each message says it again.
    legit('a short message every second, 5 min', [
      ...frames('TYPING', times(1000, 5 * MINUTE_MS)),
      ...frames(
        'MESSAGE_SEND',
        times(1000, 5 * MINUTE_MS).map((time) => time + 800),
      ),
      ...upkeep(5 * MINUTE_MS),
    ]),
    legit('a paste, sent', [...together('TYPING', 1, 0), ...together('MESSAGE_SEND', 1, 100)]),
    // The page is subscribed to every channel the person is in, so a switch is no frame: only a first
    // key in a channel not announced for three seconds is.
    legit('four channels a second, a key in each, 1 min', frames('TYPING', times(250, MINUTE_MS))),
    legit('eight channels a second, a key in each, 1 min', frames('TYPING', times(125, MINUTE_MS))),
    legit('outbox of 20 sent on reconnect', [
      ...together('SUBSCRIBE', 1, 0),
      ...together('ACTIVE', 1, 0),
      ...together('MESSAGE_SEND', 20, 0),
    ]),
    legit(`full outbox (${String(OUTBOX_MAX_MESSAGES)}) sent on reconnect`, [
      ...together('SUBSCRIBE', 1, 0),
      ...together('ACTIVE', 1, 0),
      ...together('MESSAGE_SEND', OUTBOX_MAX_MESSAGES, 0),
    ]),
  ];
  for (const [channels, roundTripMs] of [
    [100, 20],
    [1_000, 20],
    [3_500, 50],
    [3_500, 20],
    [3_500, 5],
  ] as const) {
    out.push(
      legit(
        `resubscribe ${channels.toLocaleString('en-US')} channels, ${String(roundTripMs)} ms round trip`,
        await resubscribe(channels, roundTripMs, budget),
      ),
    );
  }
  out.push({
    name: 'a flood: five hundred frames at once',
    frames: together('TYPING', 500, 0),
    legitimate: false,
  });
  return out;
};

/** One profile, through a connection's bucket and — for a send it let through — the user's. */
export const measure = async (
  profile: Profile,
  budget: RateBudget,
  writes: RateBudget = budget,
): Promise<Measured> => {
  const clock = clockAt();
  const connection: RateLimiter = inProcessRateLimiter(clock, budget);
  const user: RateLimiter = inProcessRateLimiter(clock, writes);
  let refused = 0;
  let writesRefused = 0;
  for (const frame of profile.frames) {
    clock.set(frame.at);
    if (!(await connection.consume('connection'))) refused += 1;
    else if (frame.op === 'MESSAGE_SEND' && !(await user.consume('user'))) writesRefused += 1;
  }
  const all = profile.frames;
  const peakPerSecond = Math.max(
    0,
    ...all.map((frame) => all.filter((o) => o.at >= frame.at && o.at < frame.at + 1000).length),
  );
  const burst = Math.max(0, ...all.map((frame) => all.filter((o) => o.at === frame.at).length));
  return {
    name: profile.name,
    legitimate: profile.legitimate,
    frames: all.length,
    peakPerSecond,
    burst,
    refused,
    writesRefused,
  };
};

export const measureAll = async (
  budget: RateBudget,
  writes: RateBudget = budget,
): Promise<readonly Measured[]> =>
  await Promise.all((await profiles(budget)).map(async (p) => await measure(p, budget, writes)));

/** The table, in the words D-198 records. */
export const table = (rows: readonly Measured[], budget: RateBudget): readonly string[] => [
  `budget: ${String(budget.perSecond)}/s, burst ${String(budget.burst)}`,
  'profile | frames | peak/s | burst | refused | sends refused',
  ...rows.map(
    (row) =>
      `${row.name} | ${String(row.frames)} | ${String(row.peakPerSecond)} | ${String(row.burst)} | ${String(row.refused)} | ${String(row.writesRefused)}`,
  ),
];
