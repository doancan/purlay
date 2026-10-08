/**
 * The WebSocket protocol.
 *
 * Discriminated unions, defined once (`ARCHITECTURE.md` §5.2). Only the
 * operations Phase 0 sends are here: a frame is added when the feature that
 * sends it is built, which is what keeps `switch-exhaustiveness-check`
 * meaningful instead of forcing stubs for features that do not exist. The same
 * rule the error codes follow.
 */
import { Type, type Static } from '@sinclair/typebox';
import { AppErrorBody } from './errors';
import { FromClient, Message, Uuid } from './models';

/**
 * Every client frame carries a client-generated UUIDv7 as its correlation id.
 * Written out per frame rather than through a helper: the helper's return type
 * annotation was longer and less readable than the four lines it replaced.
 */

/**
 * Send a message.
 *
 * **The frame's `id` is the message id** — the client generated it, so the
 * optimistic row and the durable row share one value and the message never moves
 * in the list when the acknowledgement lands (D-8). The server validates it
 * before trusting it: v7 shape, and a timestamp close to now (D-33).
 */
export const MessageSendFrame = FromClient({
  id: Uuid,
  op: Type.Literal('MESSAGE_SEND'),
  payload: FromClient({ channelId: Uuid, content: Type.String({ minLength: 1 }) }),
});

/**
 * Resume. Per channel the client names the highest id it holds, and the server
 * returns what it may have missed by keyset scan — one indexed range query
 * rather than a timestamp comparison with clock-skew problems
 * (`ARCHITECTURE.md` §5.4). The scan starts `REPLAY_OVERLAP_MS` below that id,
 * so some of what comes back the client already holds (D-65).
 */
export const SubscribeFrame = FromClient({
  id: Uuid,
  op: Type.Literal('SUBSCRIBE'),
  payload: FromClient({
    channels: Type.Array(
      FromClient({ channelId: Uuid, afterMessageId: Type.Union([Uuid, Type.Null()]) }),
    ),
  }),
});

export const UnsubscribeFrame = FromClient({
  id: Uuid,
  op: Type.Literal('UNSUBSCRIBE'),
  payload: FromClient({ channelIds: Type.Array(Uuid) }),
});

export const PingFrame = FromClient({
  id: Uuid,
  op: Type.Literal('PING'),
  payload: FromClient({}),
});

export const ClientFrame = Type.Union([
  MessageSendFrame,
  SubscribeFrame,
  UnsubscribeFrame,
  PingFrame,
]);
export type ClientFrame = Static<typeof ClientFrame>;
export type ClientOp = ClientFrame['op'];

/**
 * Every server frame carries the server clock — **for drift correction only,
 * never for ordering** (D-8). The client derives an offset from it so the UUIDv7
 * it generates carries a plausible timestamp (D-33). `refId` echoes the client
 * frame this answers.
 */
const envelope = { ts: Type.Number(), refId: Type.Optional(Uuid) };

/** The message is durable. Carries no row, because the client already has it. */
export const AckFrame = Type.Object({
  event: Type.Literal('ACK'),
  data: Type.Object({ id: Uuid }),
  ...envelope,
});

/**
 * Where a channel's replay stopped.
 *
 * `null` means it reached the present. Anything else means the replay was one
 * page and there is more: the client continues with
 * `GET /api/channels/:channelId/messages?after=<nextCursor>`, the same cursor and
 * the same contract as every other page (`API.md` §1). Without it a client that
 * missed more than a page is told nothing and believes it has caught up. (D-65)
 */
export const ReplayState = Type.Object({
  channelId: Uuid,
  nextCursor: Type.Union([Uuid, Type.Null()]),
});

/** Answers `SUBSCRIBE`, before the replayed messages, one entry per channel asked for. */
export const SubscribedFrame = Type.Object({
  event: Type.Literal('ACK'),
  data: Type.Object({ channels: Type.Array(ReplayState) }),
  ...envelope,
});

/** Answers `UNSUBSCRIBE`, naming the channels delivery has stopped for. */
export const UnsubscribedFrame = Type.Object({
  event: Type.Literal('ACK'),
  data: Type.Object({ channelIds: Type.Array(Uuid) }),
  ...envelope,
});

/** Never removed from the client's buffer silently — it is marked failed, with the reason. */
export const ErrorFrame = Type.Object({
  event: Type.Literal('ERROR'),
  data: AppErrorBody,
  ...envelope,
});

export const MessageCreatedFrame = Type.Object({
  event: Type.Literal('MESSAGE_CREATED'),
  data: Message,
  ...envelope,
});

export const PongFrame = Type.Object({
  event: Type.Literal('PONG'),
  data: Type.Object({}),
  ...envelope,
});

export const ServerFrame = Type.Union([
  AckFrame,
  SubscribedFrame,
  UnsubscribedFrame,
  ErrorFrame,
  MessageCreatedFrame,
  PongFrame,
]);
export type ServerFrame = Static<typeof ServerFrame>;
export type ServerEvent = ServerFrame['event'];

/** `workspace:{id}` · `channel:{id}` · `user:{id}` (`ARCHITECTURE.md` §6). */
export type Topic = `workspace:${string}` | `channel:${string}` | `user:${string}`;
