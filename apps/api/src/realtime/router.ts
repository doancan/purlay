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
import { ClientFrame, type ServerFrame } from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { AppError } from '../platform/errors';
import { requireChannelById } from '../platform/channels';
import { messageHistory, sendMessage } from '../modules/messages/messages';
import { channelTopic, type EventBus } from './bus';

/** `ARCHITECTURE.md` §5.5. Attachments never traverse the socket. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** How many missed messages a reconnect replays per channel before giving up on catching up. */
const REPLAY_LIMIT = 100;

export interface RouterDependencies {
  readonly database: Executor;
  /**
   * How to run the write path atomically (D-35).
   *
   * A dependency rather than a call to `database.transaction()`, for the reason
   * D-46 makes every executor an argument: a function that opens its own
   * transaction cannot be run inside one, and the integration harness runs
   * everything inside one it rolls back. Production supplies the real boundary;
   * a test supplies the transaction it is already in. The *shape* — one
   * transaction, publish after it returns — is identical either way, which is
   * what the tests are checking.
   */
  readonly atomically: <T>(body: (executor: Executor) => Promise<T>) => Promise<T>;
  readonly clock: Clock;
  readonly bus: EventBus;
}

export interface SocketIdentity {
  readonly socketId: string;
  readonly userId: string;
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

const errorFrame = (error: unknown, clock: Clock, refId?: string): ServerFrame => {
  const body =
    error instanceof AppError
      ? { code: error.body.code, message: error.body.message }
      : { code: 'INTERNAL' as const, message: 'Something went wrong.' };
  return frame('ERROR', body, clock, refId);
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
  const { database, clock, bus } = dependencies;

  const refuse = (message: string, refId?: string): ServerFrame =>
    errorFrame(
      new AppError({ code: 'VALIDATION_FAILED', message, details: { fields: {} } }),
      clock,
      refId,
    );

  // The framework parses JSON before this sees it and hands a string through when
  // it is not JSON — measured (`docs/spikes/elysia.md`), not assumed. Both are
  // accepted, so the router is one function over either.
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return [refuse('Frame too large.')];
    try {
      parsed = JSON.parse(raw);
    } catch {
      // No `refId`: there is no frame to answer, only bytes that were not one.
      return [refuse('That was not a frame.')];
    }
  }

  if (!Value.Check(ClientFrame, parsed)) {
    const refId =
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof parsed.id === 'string'
        ? parsed.id
        : undefined;
    return [refuse('That frame did not match the contract.', refId)];
  }

  try {
    switch (parsed.op) {
      case 'PING':
        return [frame('PONG', {}, clock, parsed.id)];

      case 'SUBSCRIBE': {
        const replayed: ServerFrame[] = [];
        for (const wanted of parsed.payload.channels) {
          // Subscribing is authorised per channel: a socket cannot listen to a
          // conversation it could not read over HTTP.
          const context = await requireChannelById(database, identity.userId, wanted.channelId);
          bus.subscribe(channelTopic(context.channelId), identity.socketId);

          if (wanted.afterMessageId !== null) {
            // "What did I miss" is one indexed range query per channel, because
            // ids are time-ordered (§5.4).
            const missed = await missedSince(database, context, wanted.afterMessageId);
            for (const message of missed) {
              replayed.push(frame('MESSAGE_CREATED', message, clock));
            }
          }
        }
        return [
          frame('ACK', { channels: parsed.payload.channels.length }, clock, parsed.id),
          ...replayed,
        ];
      }

      case 'UNSUBSCRIBE': {
        for (const channelId of parsed.payload.channelIds) {
          bus.unsubscribe(channelTopic(channelId), identity.socketId);
        }
        return [frame('ACK', { channels: parsed.payload.channelIds.length }, clock, parsed.id)];
      }

      case 'MESSAGE_SEND': {
        const context = await requireChannelById(
          database,
          identity.userId,
          parsed.payload.channelId,
        );

        // One transaction. Everything the write touches commits together or none
        // of it does (D-35).
        const message = await dependencies.atomically(
          async (transaction) =>
            await sendMessage(transaction, clock, context, {
              id: parsed.id,
              content: parsed.payload.content,
            }),
        );

        // Published only after the commit returned, never before.
        await bus.publish(
          channelTopic(context.channelId),
          frame('MESSAGE_CREATED', message, clock),
        );

        // And acknowledged after publishing, so the sender never learns of a
        // message the room has not been told about.
        return [frame('ACK', { id: message.id }, clock, parsed.id)];
      }
    }
  } catch (error) {
    return [errorFrame(error, clock, parsed.id)];
  }
};

/**
 * Everything newer than the id the client holds — a range query, oldest first.
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
): Promise<readonly unknown[]> => {
  const page = await messageHistory(executor, context, {
    after: afterMessageId,
    limit: REPLAY_LIMIT,
  });
  return page.data;
};
