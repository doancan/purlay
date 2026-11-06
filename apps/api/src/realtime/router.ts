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
import { MESSAGE_GONE, goneMessageReference } from '../platform/gone-message';
import {
  handlerOf,
  type FrameBody,
  type FrameHandlers,
  type FrameIdentity,
} from '../platform/frame-handlers';
import { Value } from '@sinclair/typebox/value';
import {
  ActiveFrame,
  ClientFrame,
  MessageSendFrame,
  PingFrame,
  SubscribeFrame,
  TYPING_TTL_MS,
  TypingFrame,
  UnsubscribeFrame,
  type ClientOp,
  type RevokedReason,
  Uuid,
  type ServerFrame,
} from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { DatabaseUnavailableError } from '@purlay/db';
import { AppError } from '../platform/errors';
import {
  isChannelMember,
  requireChannelById,
  requireChannelsById,
} from '../features/chat/channels/guard';
import { departuresFrom } from '../features/chat/channels/departures';
import { send, type missedIn } from '../features/chat/messages/messages';
import type { PushSender } from '../modules/push/sender';
import { replaySince } from '../features/chat/messages/replay';
import type { ReplayGate } from './replay-gate';
import { channelTopic, type EventBus } from '../platform/events';
import type { Atomically } from '../platform/transactions';
import { noteModule, type Logger } from '../platform/logging';
import { timedOut, withDeadline } from '../platform/request-deadline';
import type { PresenceRegistry } from './presence';
import type { OnlinePresence } from './online';
import type { Attention } from '../platform/attention';
import { requireWorkspaceMembership } from '../platform/tenancy';
import { noteSessionActivity, type SessionLifetime } from '../modules/auth/session-lifetime';
import { SESSION_CLOCK } from '../modules/auth/sessions';
import type { RateLimiter } from './rate-limiter';

const unlimited: ReplayGate = async (work) => await work();

export interface RouterDependencies {
  /**
   * The handlers of the modules this process runs, by operation (`composition.ts`, D-276): an operation with one is
   * served by it, once the router has admitted the frame. Absent, there are none, and the router serves what it serves.
   */
  readonly frameHandlers?: FrameHandlers;
  /**
   * Whether an operation is a module's that this process does not run; answered as an operation nobody has. Absent,
   * none is closed: the composition root passes it (`composition.ts`), a test of one operation need not.
   */
  readonly closedFrame?: (op: string) => boolean;
  /**
   * The module an operation belongs to, or `undefined` for one of the socket's own (`composition.ts`): a frame of a
   * module is held to that module's share of the database as its routes are (`platform/module-budget.ts`). Absent, no
   * frame belongs to one.
   */
  readonly moduleOfFrame?: (op: string) => string | undefined;
  /** How long a module's frame may take, in ms, or `undefined` for one with no deadline; absent, none has (D-270). */
  readonly deadlineOf?: (module: string) => number | undefined;
  readonly database: Executor;
  /** The write path's transaction boundary (D-35, `platform/transactions.ts`). */
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Keyed by connection (§5.5). */
  readonly limiter: RateLimiter;
  /**
   * Keyed by user, and shared with HTTP's write budget: a user's sockets and
   * requests are one person's writes, so many connections are not many budgets
   * (D-84, amended).
   */
  readonly userWrites: RateLimiter;
  /** Devices told of what a socket's send needs them for; absent where push is off (D-126). */
  readonly push?: PushSender | undefined;
  /** Who is typing where, on this node (§6.1). */
  readonly presence: PresenceRegistry;
  /** Who is in front of a workspace's page now: what holds their pushes back (D-143). */
  readonly attention: Attention;
  /** Who is online, and idle: `ACTIVE` is the page's word that keeps its person from being told away (D-257). */
  readonly online: Pick<OnlinePresence, 'active'>;
  /** How long a session lives on the server now (D-244): `ACTIVE` is use the idle timeout counts. */
  readonly sessionLifetime: () => SessionLifetime;
  readonly log: Logger;
  /** What the router needs of the connection it is answering; the hub supplies it. */
  readonly socket: SocketGate;
  /**
   * The replay read. A seam so a test can commit a message between the read and
   * what follows it, deterministically; production passes nothing.
   */
  readonly readReplay?: typeof missedIn;
  /**
   * Holds how many replays run at once on this node (`replay-gate.ts`). Absent, there is no limit: the
   * composition root passes it, a test of one operation need not.
   */
  readonly replayGate?: ReplayGate;
}

interface SocketGate {
  /** Live frames are kept, not written, until the hub's `reply` (subscribe before replay). */
  readonly hold: (socketId: string) => void;
  /** False once the connection has closed: nothing more may be subscribed for it. */
  readonly isOpen: (socketId: string) => boolean;
  /** Forgets frames kept for these channels (a refused subscription's). */
  readonly drop: (socketId: string, channelIds: readonly string[]) => void;
}

/** Who is speaking; the session is the one the connection was opened with, and its end ends the connection. */
export type SocketIdentity = FrameIdentity;

/**
 * Stamps a frame with the server clock and the id it answers. The body is one
 * member of the contract's union, so an event paired with another event's data
 * does not compile.
 */
const frame = (body: FrameBody, clock: Clock, refId?: string): ServerFrame => ({
  ...body,
  ts: clock.now().getTime(),
  ...(refId === undefined ? {} : { refId }),
});

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

/** PostgreSQL's `query_canceled`: a statement ran past its limit (`57014`), as `refusalFor` reads it. */
const isStatementCanceled = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === '57014';

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
      : goneMessageReference(error) !== undefined
        ? // A reply to a root the purge took that moment: what HTTP answers too (D-139 §2).
          MESSAGE_GONE
        : error instanceof DatabaseUnavailableError || isStatementCanceled(error)
          ? // The same body HTTP answers with (`refusalFor`), so a client handles one code (D-87).
            {
              code: 'DATABASE_UNAVAILABLE' as const,
              message: 'The service is busy. Try again shortly.',
            }
          : { code: 'INTERNAL' as const, message: 'Something went wrong.' };
  return frame({ event: 'ERROR', data: body }, clock, refId);
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
  TYPING: TypingFrame,
  ACTIVE: ActiveFrame,
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

/** The frame as an object when it is JSON, and the operation it names. */
const peek = (raw: unknown): { readonly frame: unknown; readonly op?: string } => {
  let frame: unknown = raw;
  if (typeof raw === 'string') {
    try {
      frame = JSON.parse(raw);
    } catch {
      return { frame: raw };
    }
  }
  return typeof frame === 'object' &&
    frame !== null &&
    'op' in frame &&
    typeof frame.op === 'string'
    ? { frame, op: frame.op }
    : { frame };
};

/**
 * The `ACCESS_REVOKED` a refused subscription's person would have been sent had their socket been open: for
 * the channels they were in and are not, each with why, and for no other (D-264). A channel they never were
 * in, or that does not exist, adds nothing, so their refusal is the same bytes as for a channel that was never
 * there (D-34).
 *
 * Not being able to say why is not a reason to fail the refusal: the person is told "not found", as they were
 * before there was a reason to tell, and the failure is written down.
 */
const missedRevocations = async (
  dependencies: RouterDependencies,
  userId: string,
  channelIds: readonly string[],
): Promise<readonly ServerFrame[]> => {
  let departures: ReadonlyMap<string, RevokedReason>;
  try {
    departures = await departuresFrom(dependencies.database, userId, channelIds);
  } catch (error) {
    dependencies.log.error('could not read why a refused channel is gone', { err: error });
    return [];
  }
  const byReason = new Map<RevokedReason, string[]>();
  for (const [channelId, reason] of departures) {
    byReason.set(reason, [...(byReason.get(reason) ?? []), channelId]);
  }
  return [...byReason].map(([reason, ids]) =>
    frame({ event: 'ACCESS_REVOKED', data: { channelIds: ids, reason } }, dependencies.clock),
  );
};

/**
 * Handles one frame and returns what to send back on this connection, within its module's deadline: a frame that runs past
 * it is answered `REQUEST_TIMEOUT`, and what it had asked of the database is cancelled (D-270).
 *
 * Anything published to other connections has already gone to the bus by the
 * time this returns.
 */
export const routeFrame = async (
  dependencies: RouterDependencies,
  identity: SocketIdentity,
  raw: unknown,
): Promise<readonly ServerFrame[]> => {
  const { frame, op } = peek(raw);
  const owner = op === undefined ? undefined : dependencies.moduleOfFrame?.(op);
  const ms = owner === undefined ? undefined : dependencies.deadlineOf?.(owner);
  if (owner === undefined || ms === undefined)
    return await serveFrame(dependencies, identity, frame);
  return await withDeadline(
    ms,
    async (signal) => {
      noteModule(owner, signal);
      return await serveFrame(dependencies, identity, frame);
    },
    () => {
      dependencies.log.warn('frame ran past its deadline', {
        module: owner,
        op,
        socketId: identity.socketId,
      });
      return [errorFrame(timedOut(), dependencies.clock, refIdOf(frame))];
    },
  );
};

const serveFrame = async (
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

  if (dependencies.closedFrame?.(parsed.op) === true) {
    return [
      refuse(
        'That frame did not match the contract.',
        { op: 'is not an operation this server accepts' },
        parsed.id,
      ),
    ];
  }

  const owner = dependencies.moduleOfFrame?.(parsed.op);
  if (owner !== undefined) noteModule(owner);

  try {
    // An operation a module's handler serves is the module's, whatever it is (D-276); the rest are still the router's.
    const handler = handlerOf(dependencies.frameHandlers ?? {}, parsed.op);
    if (handler !== undefined) {
      return await handler(
        {
          identity,
          database,
          atomically: dependencies.atomically,
          clock,
          bus,
          log: dependencies.log,
          reply: (body, refId) => frame(body, clock, refId),
          fail: (error, refId) => errorFrame(error, clock, refId),
        },
        parsed,
      );
    }

    switch (parsed.op) {
      case 'PING':
        return [frame({ event: 'PONG', data: {} }, clock, parsed.id)];

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

          const requests = contexts.map((context, index) => ({
            context,
            afterMessageId: wanted[index]?.afterMessageId ?? null,
          }));
          // Only a replay is held to a turn: a first subscription, with no cursor, has nothing to read, and
          // making it wait behind a storm would only delay a page that is loading.
          const turn = requests.some((request) => request.afterMessageId !== null)
            ? (dependencies.replayGate ?? unlimited)
            : unlimited;
          const replay = await turn(async () =>
            // Gone while it waited its turn: nothing is read for a connection nobody is on.
            dependencies.socket.isOpen(identity.socketId)
              ? await replaySince(database, clock, requests, dependencies.readReplay)
              : null,
          );
          if (replay === null) return [];
          const { states, frames } = replay;
          return [frame({ event: 'ACK', data: { channels: states } }, clock, parsed.id), ...frames];
        } catch (error) {
          // Nothing is left half-done behind an error: what this frame subscribed
          // is undone, and what was held for it is released with the error.
          for (const channelId of fresh) {
            bus.unsubscribe(channelTopic(channelId), identity.socketId);
          }
          // Frames that arrived for channels it was never allowed are not released
          // with the error.
          dependencies.socket.drop(identity.socketId, fresh);
          if (error instanceof AppError && error.body.code === 'CHANNEL_NOT_FOUND') {
            return [
              errorFrame(error, clock, parsed.id),
              ...(await missedRevocations(dependencies, identity.userId, channelIds)),
            ];
          }
          throw error;
        }
      }

      case 'UNSUBSCRIBE': {
        for (const channelId of parsed.payload.channelIds) {
          bus.unsubscribe(channelTopic(channelId), identity.socketId);
        }
        return [
          frame(
            { event: 'ACK', data: { channelIds: parsed.payload.channelIds } },
            clock,
            parsed.id,
          ),
        ];
      }

      case 'MESSAGE_SEND': {
        if (!(await dependencies.userWrites.consume(identity.userId))) {
          dependencies.log.info('send refused: over the user write budget', {
            socketId: identity.socketId,
          });
          return [
            errorFrame(
              new AppError({
                code: 'RATE_LIMITED',
                message: 'Too many messages. Send it again shortly.',
              }),
              clock,
              parsed.id,
            ),
          ];
        }
        const context = await requireChannelById(
          database,
          identity.userId,
          parsed.payload.channelId,
        );

        // Written, committed and published by the one send path (D-35); the ACK
        // comes after, so the sender is never ahead of the room.
        const message = await send(
          dependencies,
          context,
          {
            id: parsed.id,
            content: parsed.payload.content,
            parentId: parsed.payload.parentId,
            attachmentIds: parsed.payload.attachmentIds,
          },
          // The identity was cached at the upgrade; the write re-proves it (D-85).
          identity.sessionId,
        );
        // What they were typing has arrived; the next keystroke is news again.
        dependencies.presence.stopTyping(context.channelId, identity.userId);
        return [frame({ event: 'ACK', data: { id: message.id } }, clock, parsed.id)];
      }

      case 'TYPING': {
        // Authorised before the registry hears of it: a channel id the sender may not see must
        // neither reach a room nor take a place in memory.
        const context = await requireChannelById(
          database,
          identity.userId,
          parsed.payload.channelId,
        );
        // Seeing a public channel is not being in it: what a non-member types could not be sent
        // (D-156), so the room is not told they are typing. Dropped, not refused — an announcement
        // is not a request, and it takes no place in memory either.
        if (!(await isChannelMember(database, context))) return [];
        if (
          await dependencies.presence.startTyping(context.channelId, identity.userId, TYPING_TTL_MS)
        ) {
          await bus.publish(
            channelTopic(context.channelId),
            frame(
              {
                event: 'TYPING',
                data: {
                  channelId: context.channelId,
                  userId: identity.userId,
                  ttlMs: TYPING_TTL_MS,
                },
              },
              clock,
            ),
          );
        }
        // Nothing to answer: an announcement is not a request, and the room has heard it.
        return [];
      }

      case 'ACTIVE': {
        // A workspace the sender is not in neither holds anything nor takes a place in memory: the
        // same 404 a stranger gets.
        await requireWorkspaceMembership(database, identity.userId, parsed.payload.workspaceId);
        dependencies.attention.heard(identity.userId, parsed.payload.workspaceId);
        // And the person's page spoke: their five quiet minutes start again (D-257).
        dependencies.online.active(identity.userId);
        // The person is using this session, over a socket no request resolves: what an idle timeout counts (D-244).
        await noteSessionActivity(
          database,
          dependencies.sessionLifetime(),
          SESSION_CLOCK.now(),
          identity.sessionId,
        );
        return [];
      }
    }
  } catch (error) {
    const gone = goneMessageReference(error);
    if (gone !== undefined) {
      dependencies.log.warn('a write referred to a message that is not there', {
        constraint: gone,
        op: parsed.op,
        socketId: identity.socketId,
      });
    } else if (!(error instanceof AppError)) {
      // The client is told only INTERNAL; the cause is written here, once.
      dependencies.log.error('frame failed', {
        err: error,
        op: parsed.op,
        socketId: identity.socketId,
        ...(owner === undefined ? {} : { module: owner }),
      });
    }
    return [errorFrame(error, clock, parsed.id)];
  }
};
