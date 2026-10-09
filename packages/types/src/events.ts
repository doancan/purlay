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
import { Value } from '@sinclair/typebox/value';
import { AppErrorBody } from './errors';
import { FromClient, Message, MessageContent, Uuid } from './models';

/**
 * The largest frame either side may send, in bytes (`ARCHITECTURE.md` §5.5).
 *
 * Part of the contract because both sides need it: the server refuses a larger
 * frame by ending the connection, so a client that does not know the number finds
 * out by losing its socket. Attachments never traverse the socket. (D-66)
 */
export const MAX_FRAME_BYTES = 64 * 1024;

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
  payload: FromClient({ channelId: Uuid, content: MessageContent }),
});

/**
 * The most channels one `SUBSCRIBE` or `UNSUBSCRIBE` may name.
 *
 * A bound on the frame, not on the client: a client watching more sends more
 * frames. One hundred is several times the channel count of the teams this is
 * built for, so a reconnect is one frame; and it bounds the work one frame can
 * ask for, which before #196 was unbounded for a single rate-limit token.
 */
export const SUBSCRIBE_MAX_CHANNELS = 100;

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
    /** Each channel at most once — the server refuses a repeat, naming the field. */
    channels: Type.Array(
      FromClient({ channelId: Uuid, afterMessageId: Type.Union([Uuid, Type.Null()]) }),
      { minItems: 1, maxItems: SUBSCRIBE_MAX_CHANNELS },
    ),
  }),
});

export const UnsubscribeFrame = FromClient({
  id: Uuid,
  op: Type.Literal('UNSUBSCRIBE'),
  payload: FromClient({
    channelIds: Type.Array(Uuid, {
      minItems: 1,
      maxItems: SUBSCRIBE_MAX_CHANNELS,
      uniqueItems: true,
    }),
  }),
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

/**
 * The session behind this connection has ended, and the server closes it next
 * with `CLOSE_CODES.SESSION_ENDED`. Sent first so the client knows why, rather
 * than reconnecting into a refusal it has to interpret (#194).
 */
export const SessionEndedFrame = Type.Object({
  event: Type.Literal('SESSION_ENDED'),
  data: Type.Object({
    reason: Type.Union([Type.Literal('signed-out'), Type.Literal('expired')]),
  }),
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
  SessionEndedFrame,
  PongFrame,
]);
export type ServerFrame = Static<typeof ServerFrame>;
export type ServerEvent = ServerFrame['event'];

/**
 * A frame off the wire, or `null` for anything that is not one.
 *
 * The browser's trust boundary: a socket delivers text, and TypeScript's type for
 * it is a claim, not a check. `null` rather than a throw because a malformed
 * frame is the caller's decision — the client ends the connection and
 * reconnects, which a `try` around every read would bury. Never returns the
 * input's error detail: what a server frame failed to match is not something
 * to relay to a log that a stranger may read.
 */
export const parseServerFrame = (text: string): ServerFrame | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return Value.Check(ServerFrame, value) ? value : null;
};

/**
 * `workspace:{id}` · `channel:{id}` · `user:{id}` · `session:{id}` (`ARCHITECTURE.md` §6).
 *
 * `session:` carries the end of a session to every node holding one of its
 * sockets, which is why revocation goes through the bus rather than a local call:
 * on several nodes a local call reaches one of them (D-7, D-25).
 */
export type Topic =
  `workspace:${string}` | `channel:${string}` | `user:${string}` | `session:${string}`;

/**
 * Why the server closed a socket, for the codes the application defines
 * (4000–4999 are reserved for that by RFC 6455). Each says whether reconnecting
 * can help.
 */
export const CLOSE_CODES = {
  /** The session ended — signed out, signed out everywhere, or expired. */
  SESSION_ENDED: 4401,
  /**
   * This connection fell too far behind what the server had to send it. Unlike
   * the code above, reconnect: resubscribe with the newest id held per channel,
   * and the replay fills the gap — nothing was dropped without this close (#197).
   */
  RESYNC: 4408,
  /**
   * The server is restarting — RFC 6455's own code for it. Reconnect after a
   * backoff and replay from the cursor; a deploy is a reconnect, not a loss (#220).
   */
  RESTARTING: 1012,
} as const;
