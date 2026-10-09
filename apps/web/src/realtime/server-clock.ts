/**
 * The clock message ids are generated against.
 *
 * Ids are client-generated UUIDv7s whose timestamp is the ordering (D-8), and the
 * server refuses one more than a minute behind its own clock or five seconds
 * ahead (D-33). A laptop whose clock is wrong would either be refused or
 * interleave its messages against real time — so the client measures how far it
 * is from the server and generates against the corrected time.
 *
 * The measurement is one `PONG`: the frame carries the server clock in `ts`,
 * "for drift correction only, never for ordering" (`events.ts`). Until it
 * arrives the local clock is used unchanged. A send in that window is rare — the
 * handshake finishes long before a person finishes typing — and one the server
 * refuses surfaces as `failed` with a retry, the path `ARCHITECTURE.md` §5.3
 * already specifies. (D-33)
 */
import type { Clock } from './clock';

/** What one PING/PONG exchange tells us. */
export interface ClockSample {
  /** The local time when the `PING` left. */
  readonly sentAt: Date;
  /** The local time when its `PONG` arrived. */
  readonly receivedAt: Date;
  /** The `ts` the `PONG` carries: the server's clock, in milliseconds. */
  readonly serverTs: number;
}

export interface ServerClock extends Clock {
  /** Has a `PONG` set the offset yet? `false` means `now()` is the local clock. */
  readonly corrected: () => boolean;
  /** Derive the offset from the first sample; later samples are ignored. */
  readonly observe: (sample: ClockSample) => void;
}

export const createServerClock = (local: Clock): ServerClock => {
  let offset: number | null = null;

  return {
    now: (): Date => new Date(local.now().getTime() + (offset ?? 0)),
    corrected: (): boolean => offset !== null,
    observe: ({ sentAt, receivedAt, serverTs }): void => {
      const roundTrip = receivedAt.getTime() - sentAt.getTime();
      // A reply that arrived before its request left is a broken clock or a
      // caller bug. Taking its midpoint would fold the error into every id this
      // session makes, so it fails rather than becoming an offset. (CONTRIBUTING §6.4)
      if (roundTrip < 0) throw new Error('A PONG cannot arrive before its PING was sent');
      if (offset !== null) return;
      // The server stamped the PONG somewhere inside the round trip; the midpoint
      // is the least biased guess when the two directions are not measured apart.
      offset = serverTs - (sentAt.getTime() + roundTrip / 2);
    },
  };
};
