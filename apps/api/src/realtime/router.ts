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
import { requireChannelById } from '../platform/channels';
import { messageHistory, send } from '../modules/messages/messages';
import { channelTopic, type EventBus } from '../platform/events';
import type { Atomically } from '../platform/transactions';
import type { RateLimiter } from './rate-limiter';

/** How many missed messages a reconnect replays per channel before giving up on catching up. */
const REPLAY_LIMIT = 100;

export interface RouterDependencies {
  readonly database: Executor;
  /** The write path's transaction boundary (D-35, `platform/transactions.ts`). */
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Keyed by connection (§5.5). */
  readonly limiter: RateLimiter;
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
        const replayed: ServerFrame[] = [];
        const states: { channelId: string; nextCursor: string | null }[] = [];
        for (const wanted of parsed.payload.channels) {
          // Subscribing is authorised per channel: a socket cannot listen to a
          // conversation it could not read over HTTP.
          const context = await requireChannelById(database, identity.userId, wanted.channelId);
          bus.subscribe(channelTopic(context.channelId), identity.socketId);

          let nextCursor: string | null = null;
          if (wanted.afterMessageId !== null) {
            // "What did I miss" is one indexed range query per channel, because
            // ids are time-ordered (§5.4).
            const missed = await missedSince(database, context, wanted.afterMessageId);
            for (const message of missed.data) {
              replayed.push(frame('MESSAGE_CREATED', message, clock));
            }
            nextCursor = missed.nextCursor;
          }
          states.push({ channelId: context.channelId, nextCursor });
        }
        return [frame('ACK', { channels: states }, clock, parsed.id), ...replayed];
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
    return [errorFrame(error, clock, parsed.id)];
  }
};

/**
 * Everything the client may have missed — a range query, oldest first, starting
 * `REPLAY_OVERLAP_MS` below the id it holds.
 *
 * The first version of this read the newest page and filtered it in JavaScript,
 * while its own comment claimed to be keyset. A client away for longer than one
 * page would have silently lost the **oldest** messages it missed, which are
 * exactly the ones it needs. §5.4 asks for one indexed range query per channel;
 * this is that query.
 */
const missedSince = async (
  executor: Executor,
  context: Parameters<typeof messageHistory>[1],
  afterMessageId: string,
): Promise<Awaited<ReturnType<typeof messageHistory>>> => {
  if (!isMessageIdShape(afterMessageId)) {
    // Its timestamp is what the overlap is measured from; a cursor that is not a
    // v7 id has none, and guessing would replay from an arbitrary point.
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A replay cursor is a message id.',
      details: { fields: { afterMessageId: 'is not a message id' } },
    });
  }
  // Not from the cursor itself: a message written after the client stopped
  // listening can sort below it, and starting at the cursor loses it for good
  // (D-65). The page's `nextCursor` goes back in the ACK, so a replay longer than
  // one page says so rather than passing for complete.
  return await messageHistory(executor, context, {
    after: messageIdFloor(messageIdTime(afterMessageId) - REPLAY_OVERLAP_MS),
    limit: REPLAY_LIMIT,
  });
};
