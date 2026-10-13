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
import {
  AttachmentIds,
  Channel,
  ChannelState,
  FromClient,
  Message,
  Reaction,
  SendContent,
  ThreadSummary,
  Timestamp,
  Uuid,
} from './models';

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
  payload: FromClient({
    channelId: Uuid,
    /** Empty only beside an attachment, as in the HTTP request (D-109 §7). */
    content: SendContent,
    /** Makes it a reply to this root, as in the HTTP request (I-1). */
    parentId: Type.Optional(Uuid),
    attachmentIds: Type.Optional(AttachmentIds),
  }),
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

/**
 * How long one announcement that somebody is typing holds (D-7: ephemeral, in memory). A client
 * announces again while the person keeps typing, no more often than every half of this, and a
 * listener forgets the person when it runs out — so a closed tab or a lost connection clears
 * itself without a frame that says so.
 */
export const TYPING_TTL_MS = 6_000;

/** The sender is typing in this channel. Answered with nothing, unless it is refused. */
export const TypingFrame = FromClient({
  id: Uuid,
  op: Type.Literal('TYPING'),
  payload: FromClient({ channelId: Uuid }),
});

export const ClientFrame = Type.Union([
  MessageSendFrame,
  SubscribeFrame,
  UnsubscribeFrame,
  PingFrame,
  TypingFrame,
]);
export type ClientFrame = Static<typeof ClientFrame>;
export type ClientOp = ClientFrame['op'];

/**
 * The most channels one `ACCESS_REVOKED` names. Removing a member from a workspace
 * names every channel of it they could see; a publisher with more sends several
 * frames. Bounded so a frame stays under `MAX_FRAME_BYTES` and a hostile or
 * mistaken publisher cannot make the hub do unbounded work for one delivery.
 */
export const ACCESS_REVOKED_MAX_CHANNELS = 500;

/**
 * Every server frame carries the server clock — **for drift correction only,
 * never for ordering** (D-8). The client derives an offset from it so the UUIDv7
 * it generates carries a plausible timestamp (D-33). `refId` echoes the client
 * frame this answers.
 */
const envelope = { ts: Type.Number(), refId: Type.Optional(Uuid) };

/**
 * The order a whole-state frame's state was written in (`0015_state_versions`).
 *
 * A frame that says "this is the state, replace what you hold" is repaired by the next one —
 * and ruined by a late one: two writes commit in one order and are published in another, and
 * the older state would overwrite the newer. The version is the row's own count of its
 * changes, taken in the statement that made them, so a client keeps the newest it has applied
 * for each thing and drops a frame that is not newer. Not for ordering across *kinds*:
 * `THREAD_UPDATED`, `REACTIONS_UPDATED` and `MESSAGE_REVISED` share a message's counter, and
 * are compared only with frames of their own kind.
 */
const stateVersion = { version: Type.Integer({ minimum: 1 }) };

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
 * A root's replies changed: one arrived, or the thread was resolved or reopened.
 * The root is not re-sent — the summary is the only thing about it that moved —
 * and the frame is on the channel's topic, so everyone watching the channel hears
 * it (`API.md` §5: HTTP and the socket are two doors into one service).
 */
export const ThreadUpdatedFrame = Type.Object({
  event: Type.Literal('THREAD_UPDATED'),
  data: Type.Object({ channelId: Uuid, messageId: Uuid, thread: ThreadSummary }),
  ...stateVersion,
  ...envelope,
});

/** Somebody reacted or took it back; the message's whole set, so a client replaces rather than patches. */
export const ReactionsUpdatedFrame = Type.Object({
  event: Type.Literal('REACTIONS_UPDATED'),
  data: Type.Object({ channelId: Uuid, messageId: Uuid, reactions: Type.Array(Reaction) }),
  ...stateVersion,
  ...envelope,
});

/**
 * A message was edited or deleted (D-103): what changes when one is, and nothing else. Not the whole
 * message — its reactions and its thread have frames and versions of their own, and a late revision
 * carrying them would put back what a newer frame of those kinds had replaced. A deletion is the
 * revision to the tombstone: empty content, `deletedAt` set, nobody mentioned. On the channel's
 * topic, so everybody watching the channel hears it.
 */
export const MessageRevisedFrame = Type.Object({
  event: Type.Literal('MESSAGE_REVISED'),
  data: Type.Object(
    {
      channelId: Uuid,
      messageId: Uuid,
      /** Null for a root: a client removes a deleted root nobody answered, as the feed does. */
      parentId: Type.Union([Uuid, Type.Null()]),
      content: Type.String(),
      editedAt: Type.Union([Timestamp, Type.Null()]),
      deletedAt: Type.Union([Timestamp, Type.Null()]),
      mentions: Type.Array(Uuid),
    },
    { additionalProperties: false },
  ),
  ...stateVersion,
  ...envelope,
});

export type MessageRevision = Static<typeof MessageRevisedFrame>['data'];

/**
 * *Your* read position and counters in one channel changed — a message arrived for
 * you, or you read on another device. On the `user:` topic, so it reaches only that
 * person's sockets, and carries the server's numbers: a client that incremented its
 * own would drift from the column the first time two devices disagreed (D-13).
 */
export const ChannelStateFrame = Type.Object({
  event: Type.Literal('CHANNEL_STATE'),
  data: Type.Object({ channelId: Uuid, state: ChannelState }),
  ...stateVersion,
  ...envelope,
});

/**
 * A channel appeared for you — somebody opened a direct message with you. On the
 * `user:` topic. The client adds it and subscribes; without this a DM would not
 * exist for the other person until they reloaded.
 */
export const ChannelAddedFrame = Type.Object({
  event: Type.Literal('CHANNEL_ADDED'),
  data: Channel,
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
    reason: Type.Union([
      Type.Literal('signed-out'),
      Type.Literal('expired'),
      /** The user was deleted: every session they held ends, on every node (#238). */
      Type.Literal('account-deleted'),
    ]),
  }),
  ...envelope,
});

/** Why a channel went away, when that is worth telling somebody who was looking at it. */
export const RevokedReason = Type.Union([Type.Literal('archived'), Type.Literal('left')]);
export type RevokedReason = Static<typeof RevokedReason>;

/**
 * The connection may no longer see these channels, and delivery for them has
 * stopped. The connection stays open: every other channel it watches is
 * unaffected, which is the reason this is not a close (D-85).
 *
 * Published when a membership or a channel goes away — a member removed, a
 * channel left, a channel deleted — on the topic that reaches the affected
 * sockets on whichever node holds them. The client drops the channels from its
 * view; nothing it already holds is recalled.
 */
export const AccessRevokedFrame = Type.Object({
  event: Type.Literal('ACCESS_REVOKED'),
  data: Type.Object({
    channelIds: Type.Array(Uuid, { minItems: 1, maxItems: ACCESS_REVOKED_MAX_CHANNELS }),
    /**
     * Why, when a person looking at the channel should be told something other than "not found":
     * an admin archived it, or the person left it on another device (D-123). Absent for a removal.
     */
    reason: Type.Optional(RevokedReason),
  }),
  ...envelope,
});

/**
 * A channel's name or topic changed (D-123). The whole of both, so a client replaces what it holds;
 * on the channel's topic, at the channel row's version, and a client drops one older than what it
 * has applied — two renames published from different requests can arrive in either order.
 */
export const ChannelUpdatedFrame = Type.Object({
  event: Type.Literal('CHANNEL_UPDATED'),
  data: Type.Object(
    {
      channelId: Uuid,
      name: Type.String({ maxLength: 64 }),
      topic: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  ...stateVersion,
  ...envelope,
});

/**
 * Somebody is typing in a channel, for `ttlMs` from when this arrives — unless their message
 * arrives first, which ends it. On the channel's topic; the typist's own sockets hear it too, and
 * a client shows nobody themselves.
 */
export const TypingServerFrame = Type.Object({
  event: Type.Literal('TYPING'),
  data: Type.Object({ channelId: Uuid, userId: Uuid, ttlMs: Type.Integer({ minimum: 1 }) }),
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
  ThreadUpdatedFrame,
  ReactionsUpdatedFrame,
  MessageRevisedFrame,
  ChannelStateFrame,
  ChannelAddedFrame,
  ChannelUpdatedFrame,
  SessionEndedFrame,
  AccessRevokedFrame,
  TypingServerFrame,
  PongFrame,
]);
export type ServerFrame = Static<typeof ServerFrame>;
export type ServerEvent = ServerFrame['event'];

/** What a text frame off the wire turned out to be. */
export type ServerMessage =
  | { readonly kind: 'frame'; readonly frame: ServerFrame }
  /** An envelope with a string `event` that this client was not built to know. */
  | { readonly kind: 'unknown'; readonly event: string }
  | { readonly kind: 'malformed' };

const KNOWN_SERVER_EVENTS: ReadonlySet<string> = new Set(
  ServerFrame.anyOf.map((member) => member.properties.event.const),
);

/**
 * Classify a frame off the wire (D-82).
 *
 * The browser's trust boundary: a socket delivers text, and TypeScript's type for
 * it is a claim, not a check. Three outcomes rather than two, because a rolling
 * deploy puts a server that sends an event the client does not know in front of
 * clients built before it, and "I do not recognise this" must not look like "this
 * is broken": the first is ignored, the second ends the connection.
 *
 * **Validation of an event the contract defines is not relaxed.** A known event
 * whose data does not match is `malformed`. Only a name the contract does not
 * define is `unknown`, and only when the rest of the envelope is an object with a
 * string `event` — nothing else about an unknown event is read, so nothing about
 * it can be trusted. Never returns the input's error detail: what a server frame
 * failed to match is not something to relay to a log that a stranger may read.
 */
export const parseServerMessage = (text: string): ServerMessage => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'malformed' };
  }
  if (Value.Check(ServerFrame, value)) return { kind: 'frame', frame: value };
  if (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    typeof value.event === 'string' &&
    !KNOWN_SERVER_EVENTS.has(value.event)
  ) {
    return { kind: 'unknown', event: value.event };
  }
  return { kind: 'malformed' };
};

/**
 * `workspace:{id}` · `channel:{id}` · `user:{id}` · `session:{id}` (`ARCHITECTURE.md` §6).
 *
 * - `channel:` carries a channel's messages to the sockets watching it, its name and
 *   topic (`CHANNEL_UPDATED`), and an `ACCESS_REVOKED` when the channel itself goes away.
 * - `session:` carries the end of one session to every node holding one of its
 *   sockets, which is why revocation goes through the bus rather than a local
 *   call: on several nodes a local call reaches one of them (D-7, D-25).
 * - `user:` is where every socket a user holds listens, whichever session it
 *   belongs to: the end of the account (`SESSION_ENDED`, `account-deleted`) and the
 *   removal of one member's access (`ACCESS_REVOKED`) are published here (D-85).
 * - `user:` also carries what is true for one person only: their read state
 *   (`CHANNEL_STATE`) and a channel that appeared for them (`CHANNEL_ADDED`).
 * - `workspace:` has no publisher yet; it is named for Phase 1.
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
  /**
   * The connection sent frames faster than the server could take them in turn,
   * and the queue behind it was full — RFC 6455's own code for *try again later*.
   * Reconnect after a backoff; frames that were queued were dropped, so a send
   * that never got its `ACK` is retried like any other (D-3, `ARCHITECTURE.md` §5.5).
   */
  TOO_BUSY: 1013,
  /**
   * The server failed while opening the connection and could not say who was on
   * it — RFC 6455's own code for it. An `ERROR` frame precedes it, so the client
   * hears a frame from the contract rather than a body it cannot parse. Reconnect
   * after a backoff.
   */
  INTERNAL: 1011,
} as const;
