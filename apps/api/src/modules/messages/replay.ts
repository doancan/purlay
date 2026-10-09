/**
 * What a subscription replays, and how much of it.
 *
 * The budgets are a business rule about how a reconnecting client catches up,
 * not a property of a socket: the router asks for a replay and sends what comes
 * back (`ARCHITECTURE.md` §5.4). Nothing here knows a connection exists.
 */
import {
  REPLAY_OVERLAP_MS,
  isMessageIdShape,
  messageIdFloor,
  messageIdTime,
  type ServerFrame,
} from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { missedIn } from './messages';

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

/** A channel the caller may read, and the last message id they hold of it, if any. */
export interface ReplayRequest {
  readonly context: ChannelContext;
  readonly afterMessageId: string | null;
}

export interface ReplayResult {
  /** One per requested channel, in order: where its replay stopped (`null`: the present). */
  readonly states: { channelId: string; nextCursor: string | null }[];
  /** The messages to send, oldest first within each channel, within `REPLAY_BYTES_MAX`. */
  readonly frames: readonly ServerFrame[];
}

/**
 * Reads what each channel missed and cuts it to the budgets.
 *
 * The cursor a cut channel reports continues from the last message sent, or from
 * where it started if none was, so continuing every channel over HTTP loses
 * nothing (#197). `read` is a seam: a test commits a message between the read and
 * what follows it; production passes nothing.
 */
export const replaySince = async (
  executor: Executor,
  clock: Clock,
  requests: readonly ReplayRequest[],
  read: typeof missedIn = missedIn,
): Promise<ReplayResult> => {
  const replaying = requests.flatMap(({ context, afterMessageId }) =>
    afterMessageId === null ? [] : [{ context, after: replayFloor(afterMessageId) }],
  );
  const floors = new Map(replaying.map((entry) => [entry.context.channelId, entry.after]));
  const replays = await read(executor, replaying, replayPerChannel(replaying.length));

  const states: { channelId: string; nextCursor: string | null }[] = [];
  const frames: ServerFrame[] = [];
  let bytes = 0;
  for (const { context } of requests) {
    const replay = replays.get(context.channelId);
    let resumeFrom = floors.get(context.channelId) ?? null;
    let cut = false;
    for (const message of replay?.data ?? []) {
      const created: ServerFrame = {
        event: 'MESSAGE_CREATED',
        data: message,
        ts: clock.now().getTime(),
      };
      const size = Buffer.byteLength(JSON.stringify(created), 'utf8');
      if (bytes + size > REPLAY_BYTES_MAX) {
        cut = true;
        break;
      }
      bytes += size;
      frames.push(created);
      resumeFrom = message.id;
    }
    states.push({
      channelId: context.channelId,
      nextCursor: cut ? resumeFrom : (replay?.nextCursor ?? null),
    });
  }
  return { states, frames };
};
