/**
 * What a person does in a channel over the socket, as chat serves it (`frameHandlers` of `module.ts`, D-276): the router
 * has counted the frame, parsed it, held it to chat's deadline and share of the pool, and answers what a handler throws.
 * Each handler answers exactly what the router answered before the operations moved here: the same acknowledgements, the
 * same errors, the same order.
 */
import { TYPING_TTL_MS } from '@purlay/types';
import type { FrameContext, FrameHandlers } from '../../platform/frame-handlers';
import { AppError } from '../../platform/errors';
import { channelTopic } from '../../platform/events';
import type { PushSender } from '../../modules/push/sender';
import { isChannelMember, requireChannelById } from './channels/guard';
import { send } from './messages/messages';

/** Who is typing where: what `TYPING` asks of the node's registry. */
interface TypingWindows {
  readonly startTyping: (
    channelId: string,
    userId: string,
    ttlMs: number,
  ) => boolean | Promise<boolean>;
  readonly stopTyping: (channelId: string, userId: string) => void;
}

/** What chat's handlers use of the socket's context beyond the context every module's are given. */
export interface ChatFrameContext extends FrameContext {
  /** Devices told of what a send needs them for; absent where push is off (D-126). */
  readonly push: PushSender | undefined;
  readonly presence: TypingWindows;
}

export const chatFrameHandlers: FrameHandlers<ChatFrameContext> = {
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
