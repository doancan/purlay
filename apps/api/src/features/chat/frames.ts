/**
 * What a person does in a channel over the socket, as chat serves it (`frameHandlers` of `module.ts`, D-276): the router
 * has counted the frame, parsed it, held it to chat's deadline and share of the pool, and answers what a handler throws.
 * Each handler answers exactly what the router answered before the operations moved here: the same acknowledgements, the
 * same errors, the same order.
 */
import { TYPING_TTL_MS, type RevokedReason, type ServerFrame } from '@purlay/types';
import type { FrameContext, FrameHandlers } from '../../platform/frame-handlers';
import { AppError } from '../../platform/errors';
import { channelTopic } from '../../platform/events';
import type { PushSender } from '../../modules/push/sender';
import { departuresFrom } from './channels/departures';
import { isChannelMember, requireChannelById, requireChannelsById } from './channels/guard';
import { missedIn, send } from './messages/messages';
import { replaySince } from './messages/replay';
import type { ChannelDeliveryGate } from '../../platform/ports/channel-delivery';
import { liveChannelScope } from './channels/live-history';

/** Who is typing where: what `TYPING` asks of the node's registry. */
interface TypingWindows {
  readonly startTyping: (
    channelId: string,
    userId: string,
    ttlMs: number,
  ) => boolean | Promise<boolean>;
  readonly stopTyping: (channelId: string, userId: string) => void;
}

/** What a subscription asks of the connection it is for. */
interface SocketGate extends ChannelDeliveryGate {
  /** Live frames are kept, not written, until the hub's `reply` (subscribe before replay). */
  readonly hold: (socketId: string) => void;
  /** False once the connection has closed: nothing more may be subscribed for it. */
  readonly isOpen: (socketId: string) => boolean;
  /** Forgets frames kept for these channels (a refused subscription's). */
  readonly drop: (socketId: string, channelIds: readonly string[]) => void;
}

/** What a replay waits for: the node's few turns at once (`replay-gate.ts`). */
type ReplayGate = <T>(work: () => Promise<T>) => Promise<T>;

const unlimited: ReplayGate = async (work) => await work();

/** What chat's handlers use of the socket's context beyond the context every module's are given. */
export interface ChatFrameContext extends FrameContext {
  readonly socket: SocketGate;
  readonly replayGate: ReplayGate;
  /** Devices told of what a send needs them for; absent where push is off (D-126). */
  readonly push: PushSender | undefined;
  readonly presence: TypingWindows;
}

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
  context: ChatFrameContext,
  channelIds: readonly string[],
): Promise<readonly ServerFrame[]> => {
  let departures: ReadonlyMap<string, RevokedReason>;
  try {
    departures = await departuresFrom(context.database, context.identity.userId, channelIds);
  } catch (error) {
    context.log.error('could not read why a refused channel is gone', { err: error });
    return [];
  }
  const byReason = new Map<RevokedReason, string[]>();
  for (const [channelId, reason] of departures) {
    byReason.set(reason, [...(byReason.get(reason) ?? []), channelId]);
  }
  return [...byReason].map(([reason, ids]) =>
    context.reply({ event: 'ACCESS_REVOKED', data: { channelIds: ids, reason } }),
  );
};

const channelWrites: FrameHandlers<ChatFrameContext> = {
  MESSAGE_SEND: async (context, frame) => {
    const { identity, userWrites, log, presence } = context;
    if (!(await userWrites.consume(identity.userId))) {
      log.info('send refused: over the user write budget', { socketId: identity.socketId });
      return [
        context.fail(
          new AppError({
            code: 'RATE_LIMITED',
            message: 'Too many messages. Send it again shortly.',
          }),
          frame.id,
        ),
      ];
    }
    const channel = await requireChannelById(
      context.database,
      identity.userId,
      frame.payload.channelId,
    );

    // Written, committed and published by the one send path (D-35); the ACK
    // comes after, so the sender is never ahead of the room.
    const message = await send(
      context,
      channel,
      {
        id: frame.id,
        content: frame.payload.content,
        parentId: frame.payload.parentId,
        attachmentIds: frame.payload.attachmentIds,
      },
      // The identity was cached at the upgrade; the write re-proves it (D-85).
      identity.sessionId,
    );
    // What they were typing has arrived; the next keystroke is news again.
    presence.stopTyping(channel.channelId, identity.userId);
    return [context.reply({ event: 'ACK', data: { id: message.id } }, frame.id)];
  },

  TYPING: async (context, frame) => {
    const { identity, presence } = context;
    // Authorised before the registry hears of it: a channel id the sender may not see must
    // neither reach a room nor take a place in memory.
    const channel = await requireChannelById(
      context.database,
      identity.userId,
      frame.payload.channelId,
    );
    // Seeing a public channel is not being in it: what a non-member types could not be sent
    // (D-156), so the room is not told they are typing. Dropped, not refused — an announcement
    // is not a request, and it takes no place in memory either.
    if (!(await isChannelMember(context.database, channel))) return [];
    if (await presence.startTyping(channel.channelId, identity.userId, TYPING_TTL_MS)) {
      await context.bus.publish(
        channelTopic(channel.channelId),
        context.reply({
          event: 'TYPING',
          data: { channelId: channel.channelId, userId: identity.userId, ttlMs: TYPING_TTL_MS },
        }),
      );
    }
    // Nothing to answer: an announcement is not a request, and the room has heard it.
    return [];
  },
};

/**
 * `readReplay` is a seam so a test can commit a message between the read and what follows it, deterministically;
 * production takes the default.
 */
export const chatFrames = (
  readReplay: typeof missedIn = missedIn,
): FrameHandlers<ChatFrameContext> => {
  const channelScope = liveChannelScope();
  const subscriptions: FrameHandlers<ChatFrameContext> = {
    SUBSCRIBE: async (context, frame) => {
      const { identity, socket, bus, database, clock } = context;
      const wanted = frame.payload.channels;
      const channelIds = wanted.map((entry) => entry.channelId);
      if (new Set(channelIds).size !== channelIds.length) {
        return [
          context.fail(
            new AppError({
              code: 'VALIDATION_FAILED',
              message: 'A channel is named twice.',
              details: { fields: { 'payload/channels': 'names a channel more than once' } },
            }),
            frame.id,
          ),
        ];
      }

      // Gone before it began: subscribe nothing for a connection whose cleanup has
      // already run, or its id outlives it.
      if (!socket.isOpen(identity.socketId)) return [];

      // **Subscribed before anything is read**, with live frames held until the
      // acknowledgement and the replay are written. Read first, a message
      // committed between the read and the subscription is in neither, and the
      // client's cursor then moves past it for good (D-83). Subscribed before the
      // channels are *authorised* too, so that a revocation published while the
      // authorisation is being read finds the subscription and ends it; made after,
      // it would find nothing and the stale authorisation would then subscribe (D-85).
      socket.hold(identity.socketId);
      const fresh: string[] = [];
      for (const channelId of channelIds) {
        if (bus.subscribe(channelTopic(channelId), identity.socketId)) fresh.push(channelId);
      }

      try {
        // Authorised together: one channel the caller cannot see refuses the frame,
        // and what was subscribed above is undone. One query, however many channels
        // (#196).
        const contexts = await requireChannelsById(database, identity.userId, channelIds);
        for (const channel of contexts) {
          const scope = channelScope(database, channel);
          // Any member can later be readmitted as a guest, even when a control publication is lost.
          // An older transport cannot safely retain an unguarded subscription across that change.
          if (socket.restrictChannel === undefined || socket.releaseChannels === undefined)
            throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
          socket.restrictChannel(identity.socketId, channel.channelId, scope);
        }
        // Gone while its channels were being authorised: the close already forgot
        // every subscription, and nothing below adds one.
        if (!socket.isOpen(identity.socketId)) return [];

        const requests = contexts.map((channel, index) => ({
          context: channel,
          afterMessageId: wanted[index]?.afterMessageId ?? null,
        }));
        // Only a replay is held to a turn: a first subscription, with no cursor, has nothing to read, and
        // making it wait behind a storm would only delay a page that is loading.
        const turn = requests.some((request) => request.afterMessageId !== null)
          ? context.replayGate
          : unlimited;
        const replay = await turn(async () =>
          // Gone while it waited its turn: nothing is read for a connection nobody is on.
          socket.isOpen(identity.socketId)
            ? await replaySince(database, clock, requests, readReplay)
            : null,
        );
        if (replay === null) return [];
        const { states, frames } = replay;
        return [context.reply({ event: 'ACK', data: { channels: states } }, frame.id), ...frames];
      } catch (error) {
        // Nothing is left half-done behind an error: what this frame subscribed
        // is undone, and what was held for it is released with the error.
        for (const channelId of fresh) {
          bus.unsubscribe(channelTopic(channelId), identity.socketId);
        }
        // Frames that arrived for channels it was never allowed are not released
        // with the error.
        socket.drop(identity.socketId, fresh);
        if (error instanceof AppError && error.body.code === 'CHANNEL_NOT_FOUND') {
          return [context.fail(error, frame.id), ...(await missedRevocations(context, channelIds))];
        }
        throw error;
      }
    },

    UNSUBSCRIBE: (context, frame) => {
      context.socket.releaseChannels?.(context.identity.socketId, frame.payload.channelIds);
      for (const channelId of frame.payload.channelIds) {
        context.bus.unsubscribe(channelTopic(channelId), context.identity.socketId);
      }
      return Promise.resolve([
        context.reply({ event: 'ACK', data: { channelIds: frame.payload.channelIds } }, frame.id),
      ]);
    },
  };
  return { ...subscriptions, ...channelWrites };
};

export const chatFrameHandlers: FrameHandlers<ChatFrameContext> = chatFrames();
