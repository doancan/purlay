/**
 * The frame router: what a socket is allowed to say, and what it gets back.
 *
 * Every reply is a `ServerFrame`, and every frame the router produces in answer
 * to a client frame echoes its `refId` — so a client can match an answer to the
 * thing it asked, which is what makes the optimistic model reconcilable
 * (`ARCHITECTURE.md` §5.2).
 *
 * **The write path is one transaction, and the event is published after it
 * commits** (D-35). Publishing from inside the transaction lets a subscriber
 * receive a message that then rolls back — and because the id is durable and
 * client-generated, the receiving client has no way to learn it should forget it.
 *
 * The router never touches a socket: it publishes to the bus and returns the
 * frames meant for this connection. That is the separation the Phase 3 adapter
 * swap depends on (D-7).
 */
import { Value } from '@sinclair/typebox/value';
import {
  ClientFrame,
  MessageSendFrame,
  PingFrame,
  SubscribeFrame,
  UnsubscribeFrame,
  type ClientOp,
  REPLAY_OVERLAP_MS,
  isMessageIdShape,
  messageIdFloor,
  messageIdTime,
  Uuid,
  type ServerFrame,
} from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { AppError } from '../platform/errors';
import { requireChannelById, requireChannelsById } from '../platform/channels';
import { missedIn, send } from '../modules/messages/messages';
import { channelTopic, type EventBus } from '../platform/events';
import type { Atomically } from '../platform/transactions';
import type { Logger } from '../platform/logging';
import type { RateLimiter } from './rate-limiter';

/**
 * How much one subscription replays, at most, across every channel it names.
 *
 * A hundred channels each a page behind was ten thousand frames from one frame
 * (#196). The total is fixed and shared: one channel gets a full page, many get a
 * smaller one each, never fewer than `REPLAY_PER_CHANNEL_MIN`. Whatever is left
 * is continued over HTTP from the `nextCursor` the acknowledgement carries (D-65).
 */
const REPLAY_TOTAL = 1_000;

/**
 * And at most this many bytes, because a count does not bound a burst: a
 * thousand of the longest messages is 48 MB. The outbound high-water mark must
 * exceed this, or a healthy reader would be closed by its own replay and loop
 * (`OUTBOUND_HIGH_WATER_MARK`, bound by a test).
 */
export const REPLAY_BYTES_MAX = 1024 * 1024;
const REPLAY_PER_CHANNEL_MAX = 100;
const REPLAY_PER_CHANNEL_MIN = 10;

/** The page each replaying channel gets when `count` of them share the total. */
export const replayPerChannel = (count: number): number =>
  Math.min(
    REPLAY_PER_CHANNEL_MAX,
    Math.max(REPLAY_PER_CHANNEL_MIN, Math.floor(REPLAY_TOTAL / Math.max(1, count))),
  );

export interface RouterDependencies {
  readonly database: Executor;
  /** The write path's transaction boundary (D-35, `platform/transactions.ts`). */
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Keyed by connection (§5.5). */
  readonly limiter: RateLimiter;
  readonly log: Logger;
  /** What the router needs of the connection it is answering; the hub supplies it. */
  readonly socket: SocketGate;
  /**
   * The replay read. A seam so a test can commit a message between the read and
   * what follows it, deterministically; production passes nothing.
   */
  readonly readReplay?: typeof missedIn;
}

export interface SocketGate {
  /** Live frames are kept, not written, until the hub's `reply` (subscribe before replay). */
  readonly hold: (socketId: string) => void;
  /** False once the connection has closed: nothing more may be subscribed for it. */
  readonly isOpen: (socketId: string) => boolean;
  /** Forgets frames kept for these channels (a refused subscription's). */
  readonly drop: (socketId: string, channelIds: readonly string[]) => void;
}

export interface SocketIdentity {
  readonly socketId: string;
  readonly userId: string;
  /** The session the connection was opened with; its end ends the connection. */
  readonly sessionId: string;
  readonly expiresAt: Date;
}

const frame = (
  event: ServerFrame['event'],
  data: unknown,
  clock: Clock,
  refId?: string,
): ServerFrame =>
  ({
    event,
    data,
    ts: clock.now().getTime(),
    ...(refId === undefined ? {} : { refId }),
  }) as ServerFrame;

/**
 * The id to echo back, if the frame had one that can be.
 *
 * Only a UUID: `refId` is one in the contract, and echoing whatever a malformed
 * frame carried would answer a contract violation with another.
 */
const refIdOf = (raw: unknown): string | undefined =>
  typeof raw === 'object' && raw !== null && 'id' in raw && Value.Check(Uuid, raw.id)
    ? raw.id
    : undefined;

/**
 * The whole body of an `AppError`, which is written for the client — including
 * `details`, which the contract requires of a validation failure. Dropping it
 * sent every socket validation error outside the contract, and told the composer
 * nothing about which field to fix while HTTP named it.
 */
const errorFrame = (error: unknown, clock: Clock, refId?: string): ServerFrame => {
  const body =
    error instanceof AppError
      ? error.body
      : { code: 'INTERNAL' as const, message: 'Something went wrong.' };
  return frame('ERROR', body, clock, refId);
};

/**
 * Each operation's own schema. `satisfies` makes it total: an operation added to
 * the contract without a schema here does not compile.
 */
const FRAME_BY_OP = {
  MESSAGE_SEND: MessageSendFrame,
  SUBSCRIBE: SubscribeFrame,
  UNSUBSCRIBE: UnsubscribeFrame,
  PING: PingFrame,
} as const satisfies Record<ClientOp, unknown>;

const isClientOp = (value: unknown): value is ClientOp =>
  typeof value === 'string' && Object.hasOwn(FRAME_BY_OP, value);

/**
 * Which fields of a refused frame were wrong, in the shape HTTP reports them
 * (`API.md` §1) — the path and why, never the value sent.
 *
 * Checked against the frame's own operation rather than the union: against the
 * union every field of every other operation is "wrong", which names nothing.
 */
const fieldsOf = (parsed: unknown): Record<string, string> => {
  const op =
    typeof parsed === 'object' && parsed !== null && 'op' in parsed ? parsed.op : undefined;
  if (!isClientOp(op)) return { op: 'is not an operation this server accepts' };
  const fields: Record<string, string> = {};
  for (const error of Value.Errors(FRAME_BY_OP[op], parsed)) {
    fields[error.path.replace(/^\//, '') || 'frame'] ??= error.message;
  }
  return fields;
};

/**
 * Handles one frame and returns what to send back on this connection.
 *
 * Anything published to other connections has already gone to the bus by the
 * time this returns.
 */
export const routeFrame = async (
  dependencies: RouterDependencies,
  identity: SocketIdentity,
  raw: unknown,
): Promise<readonly ServerFrame[]> => {
  const { database, clock, bus, limiter } = dependencies;

  // Counted before anything else, malformed frames included: if bytes that are
  // not a frame cost nothing, they are the cheapest flood there is.
  if (!(await limiter.consume(identity.socketId))) {
    // Counted, because this is what closes O-4: how often legitimate use meets
    // the budget, measured during dogfooding.
    dependencies.log.info('frame refused: over the rate budget', { socketId: identity.socketId });
    return [
      errorFrame(
        new AppError({ code: 'RATE_LIMITED', message: 'Too many frames. Send it again shortly.' }),
        clock,
        refIdOf(raw),
      ),
    ];
  }

  const refuse = (message: string, fields: Record<string, string>, refId?: string): ServerFrame =>
    errorFrame(
      new AppError({ code: 'VALIDATION_FAILED', message, details: { fields } }),
      clock,
      refId,
    );

  // The framework parses JSON before this sees it and hands a string through when
  // it is not JSON — measured (`docs/spikes/elysia.md`), not assumed. Both are
  // accepted, so the router is one function over either.
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // No `refId`: there is no frame to answer, only bytes that were not one.
      return [refuse('That was not a frame.', { frame: 'is not JSON' })];
    }
  }

  if (!Value.Check(ClientFrame, parsed)) {
    return [refuse('That frame did not match the contract.', fieldsOf(parsed), refIdOf(parsed))];
  }

  try {
    switch (parsed.op) {
      case 'PING':
        return [frame('PONG', {}, clock, parsed.id)];

      case 'SUBSCRIBE': {
        const wanted = parsed.payload.channels;
        const channelIds = wanted.map((entry) => entry.channelId);
        if (new Set(channelIds).size !== channelIds.length) {
          return [
            refuse(
              'A channel is named twice.',
              { 'payload/channels': 'names a channel more than once' },
              parsed.id,
            ),
          ];
        }

        // Gone before it began: subscribe nothing for a connection whose cleanup has
        // already run, or its id outlives it.
        if (!dependencies.socket.isOpen(identity.socketId)) return [];

        // **Subscribed before anything is read**, with live frames held until the
        // acknowledgement and the replay are written. Read first, a message
        // committed between the read and the subscription is in neither, and the
        // client's cursor then moves past it for good (D-83). Subscribed before the
        // channels are *authorised* too, so that a revocation published while the
        // authorisation is being read finds the subscription and ends it; made after,
        // it would find nothing and the stale authorisation would then subscribe (D-85).
        dependencies.socket.hold(identity.socketId);
        const fresh: string[] = [];
        for (const channelId of channelIds) {
          if (bus.subscribe(channelTopic(channelId), identity.socketId)) fresh.push(channelId);
        }

        try {
          // Authorised together: one channel the caller cannot see refuses the frame,
          // and what was subscribed above is undone. One query, however many channels
          // (#196).
          const contexts = await requireChannelsById(database, identity.userId, channelIds);
          // Gone while its channels were being authorised: the close already forgot
          // every subscription, and nothing below adds one.
          if (!dependencies.socket.isOpen(identity.socketId)) return [];

          const replaying = contexts.flatMap((context, index) => {
            const after = wanted[index]?.afterMessageId ?? null;
            return after === null ? [] : [{ context, after: replayFloor(after) }];
          });
          const floors = new Map(replaying.map((entry) => [entry.context.channelId, entry.after]));
          const replays = await (dependencies.readReplay ?? missedIn)(
            database,
            replaying,
            replayPerChannel(replaying.length),
          );

          const states: { channelId: string; nextCursor: string | null }[] = [];
          const replayed: ServerFrame[] = [];
          let bytes = 0;
          for (const context of contexts) {
            const replay = replays.get(context.channelId);
            // Where this channel's replay continues if the byte budget stops it:
            // after the last message sent, or from its start if none was.
            let resumeFrom = floors.get(context.channelId) ?? null;
            let cut = false;
            for (const message of replay?.data ?? []) {
              const created = frame('MESSAGE_CREATED', message, clock);
              const size = Buffer.byteLength(JSON.stringify(created), 'utf8');
              if (bytes + size > REPLAY_BYTES_MAX) {
                cut = true;
                break;
              }
              bytes += size;
              replayed.push(created);
              resumeFrom = message.id;
            }
            states.push({
              channelId: context.channelId,
              nextCursor: cut ? resumeFrom : (replay?.nextCursor ?? null),
            });
          }
          return [frame('ACK', { channels: states }, clock, parsed.id), ...replayed];
        } catch (error) {
          // Nothing is left half-done behind an error: what this frame subscribed
          // is undone, and what was held for it is released with the error.
          for (const channelId of fresh) {
            bus.unsubscribe(channelTopic(channelId), identity.socketId);
          }
          // Frames that arrived for channels it was never allowed are not released
          // with the error.
          dependencies.socket.drop(identity.socketId, fresh);
          throw error;
        }
      }

      case 'UNSUBSCRIBE': {
        for (const channelId of parsed.payload.channelIds) {
          bus.unsubscribe(channelTopic(channelId), identity.socketId);
        }
        return [frame('ACK', { channelIds: parsed.payload.channelIds }, clock, parsed.id)];
      }

      case 'MESSAGE_SEND': {
        const context = await requireChannelById(
          database,
          identity.userId,
          parsed.payload.channelId,
        );

        // Written, committed and published by the one send path (D-35); the ACK
        // comes after, so the sender is never ahead of the room.
        const message = await send(dependencies, context, {
          id: parsed.id,
          content: parsed.payload.content,
        });
        return [frame('ACK', { id: message.id }, clock, parsed.id)];
      }
    }
  } catch (error) {
    if (!(error instanceof AppError)) {
      // The client is told only INTERNAL; the cause is written here, once.
      dependencies.log.error('frame failed', {
        err: error,
        op: parsed.op,
        socketId: identity.socketId,
      });
    }
    return [errorFrame(error, clock, parsed.id)];
  }
};

/**
 * Where a channel's replay starts: `REPLAY_OVERLAP_MS` below the id the client
 * holds, not at it — a message written after the client stopped listening can
 * sort below that id, and starting at the cursor loses it for good (D-65).
 */
const replayFloor = (afterMessageId: string): string => {
  if (!isMessageIdShape(afterMessageId)) {
    // Its timestamp is what the overlap is measured from; a cursor that is not a
    // v7 id has none, and guessing would replay from an arbitrary point.
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A replay cursor is a message id.',
      details: { fields: { afterMessageId: 'is not a message id' } },
    });
  }
  return messageIdFloor(messageIdTime(afterMessageId) - REPLAY_OVERLAP_MS);
};
