/** Current authority is batched only before dispatch; no completed or already-started read can authorize a late recipient. */
import type { ServerFrame } from '@purlay/types';
import { withinRequest } from '../../../platform/logging';
import type { ChatDb } from '../schema';
import {
  LIVE_AUDIENCE_BATCH_MAX,
  readLiveChannelAudience,
  type ChannelContext,
  type LiveChannelAuthority,
} from './guard';

interface Waiting {
  readonly userId: string;
  readonly needsHistory: boolean;
  readonly signal: AbortSignal;
  readonly resolve: (authority: LiveChannelAuthority | undefined) => void;
  readonly reject: (error: unknown) => void;
}

/** A factory belongs to the transport's guest history projector; executor identity is part of its namespace. */
export const liveAudienceReader = (): ((
  database: ChatDb,
  context: ChannelContext,
  frame: ServerFrame,
  messageId: string | undefined,
  signal: AbortSignal,
) => Promise<LiveChannelAuthority | undefined>) => {
  const executors = new WeakMap<ChatDb, WeakMap<ServerFrame, Map<string, Waiting[]>>>();
  return (database, context, frame, messageId, signal) => {
    const frames = executors.get(database) ?? new WeakMap<ServerFrame, Map<string, Waiting[]>>();
    executors.set(database, frames);
    const scopes = frames.get(frame) ?? new Map<string, Waiting[]>();
    frames.set(frame, scopes);
    const key = JSON.stringify([context.workspaceId, context.channelId, messageId]);
    let waiting = scopes.get(key);
    if (waiting === undefined) {
      waiting = [];
      scopes.set(key, waiting);
      const batch = waiting;
      queueMicrotask(() => {
        // Detach before dispatch, not after completion: later callers need a new statement snapshot.
        if (scopes.get(key) === batch) scopes.delete(key);
        const run = async (): Promise<void> => {
          const users = new Map<string, Waiting[]>();
          for (const waiter of batch) {
            if (waiter.signal.aborted) {
              waiter.reject(waiter.signal.reason);
              continue;
            }
            const interested = users.get(waiter.userId) ?? [];
            interested.push(waiter);
            users.set(waiter.userId, interested);
          }
          const ids = [...users.keys()];
          for (let from = 0; from < ids.length; from += LIVE_AUDIENCE_BATCH_MAX) {
            const selected = ids.slice(from, from + LIVE_AUDIENCE_BATCH_MAX);
            const recipients = selected.flatMap((id) => users.get(id) ?? []);
            const active = recipients.find((recipient) => !recipient.signal.aborted);
            if (active === undefined) {
              for (const recipient of recipients) recipient.reject(recipient.signal.reason);
              continue;
            }
            try {
              const rows = await withinRequest(
                {
                  requestId: `live:chat:audience:${context.channelId}`,
                  startedAt: performance.now(),
                  module: 'chat',
                  signal: active.signal,
                },
                async () =>
                  await readLiveChannelAudience(
                    database,
                    context,
                    selected,
                    // Full scopes still recheck current authority; only guest scopes compare the
                    // trusted message time. A mixed batch retains that lookup for its guests.
                    recipients.some((recipient) => recipient.needsHistory) ? messageId : undefined,
                  ),
              );
              const known = new Map(rows.map((row) => [row.userId, row]));
              for (const recipient of recipients) {
                if (recipient.signal.aborted) recipient.reject(recipient.signal.reason);
                else recipient.resolve(known.get(recipient.userId));
              }
            } catch (error) {
              for (const recipient of recipients) recipient.reject(error);
            }
          }
        };
        void run();
      });
    }
    const queued = waiting;
    return new Promise<LiveChannelAuthority | undefined>((resolve, reject) => {
      queued.push({
        userId: context.userId,
        needsHistory: context.guest !== undefined,
        signal,
        resolve,
        reject,
      });
      if (queued.length >= LIVE_AUDIENCE_BATCH_MAX && scopes.get(key) === queued)
        scopes.delete(key);
    });
  };
};
