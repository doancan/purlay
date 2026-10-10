/**
 * The client's realtime half: frames in, the cache taught; a send out, painted at once.
 *
 * `connection.ts` owns the socket's life — connect, back off, resubscribe, replay. This
 * owns what the frames *mean* and what a person's own send does between the keystroke
 * and the acknowledgement (`ARCHITECTURE.md` §5.3):
 *
 * 1. The id is a UUIDv7 made now, against the corrected server clock. It is the
 *    message's id for good, so the row never moves when the ACK lands (D-8).
 * 2. The row exists **in the store** as `sending` before anything leaves — the paint
 *    that must fit one frame never waits on a network.
 * 3. The frame goes out over the socket; if the socket is not open, over HTTP, which
 *    is the same service (`API.md` §5).
 * 4. No ACK within three seconds is `failed`, with the reason, and the person's
 *    Retry sends the *same id* again — idempotent by construction (D-8). A row is
 *    never dropped without telling anybody.
 * 5. The server's `MESSAGE_CREATED` echo teaches the cache the real row and retires
 *    the pending one. A reconnect re-sends what was still `sending`.
 *
 * Everything outside the process is an argument (the socket, the timers, the clock,
 * the dice), so a test drives a dropped connection by hand (D-46).
 */
import type { QueryClient } from '@tanstack/react-query';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { messageId, type Channel, type ClientFrame, type ServerFrame } from '@purlay/types';
import type { Api } from '../data/api';
import {
  channelAdded,
  channelStateChanged,
  channelsRevoked,
  messageCreated,
  reactionsUpdated,
  threadUpdated,
} from '../data/cache';
import { families } from '../data/keys';
import { isApiError } from '../data/errors';
import type { Clock } from './clock';
import {
  createConnection,
  type Connection,
  type ConnectionStatus,
  type OpenSocket,
  type Schedule,
} from './connection';
import { createServerClock } from './server-clock';

/** How long a send may wait for its ACK before it is shown as failed (`UX.md` §3.1). */
export const ACK_DEADLINE_MS = 3_000;

export type Delivery = 'sending' | 'sent' | 'failed';

/** A message the person sent that the server has not yet been heard to have. */
export interface PendingMessage {
  readonly id: string;
  readonly channelId: string;
  readonly parentId: string | null;
  readonly content: string;
  /** When the person sent it, by the corrected clock — the row's time until the echo says. */
  readonly createdAt: string;
  readonly delivery: Delivery;
  /** Why it failed, in the server's words when it said any; null otherwise. */
  readonly reason: string | null;
}

export interface RealtimeState {
  readonly status: ConnectionStatus;
  readonly pending: readonly PendingMessage[];
}

export interface Outgoing {
  readonly channelId: string;
  readonly content: string;
  readonly parentId?: string | undefined;
}

export interface EngineOptions {
  readonly api: Api;
  readonly client: QueryClient;
  readonly url: string;
  readonly openSocket: OpenSocket;
  readonly schedule: Schedule;
  readonly random: () => number;
  readonly clock: Clock;
  /** The session ended — signed out elsewhere, or expired. */
  readonly onSessionEnded: () => void;
}

export interface Engine {
  readonly store: StoreApi<RealtimeState>;
  readonly start: () => void;
  readonly stop: () => void;
  /** Receive exactly these channels; the others are let go. */
  readonly watch: (channelIds: readonly string[]) => void;
  /** Sends, and returns the id the message has for good. */
  readonly send: (message: Outgoing) => string;
  readonly retry: (id: string) => void;
  /** Removes a failed message the person does not want to resend. */
  readonly discard: (id: string) => void;
}

const isSendAck = (
  frame: ServerFrame,
): frame is Extract<ServerFrame, { event: 'ACK' }> & {
  data: { id: string };
} => frame.event === 'ACK' && 'id' in frame.data;

export const createEngine = (options: EngineOptions): Engine => {
  const { api, client, schedule } = options;
  const store = createStore<RealtimeState>(() => ({ status: 'idle', pending: [] }));
  const serverClock = createServerClock(options.clock);
  const timers = new Map<string, () => void>();
  const watched = new Set<string>();
  // The newest version of each whole state a frame has taught the cache, by kind and thing.
  // Frames are published after their commits and from different requests, so a late one can
  // arrive behind a newer one; replacing the newer state with it would stick until something
  // else moved. Older is dropped, equal is applied again (a re-told state repairs a lost one).
  const applied = new Map<string, number>();
  const isNewest = (kind: string, id: string, version: number): boolean => {
    const key = `${kind}:${id}`;
    if (version < (applied.get(key) ?? 0)) return false;
    applied.set(key, version);
    return true;
  };
  let connection: Connection | null = null;
  let opened = false;

  const change = (
    edit: (pending: readonly PendingMessage[]) => readonly PendingMessage[],
  ): void => {
    store.setState((state) => ({ pending: edit(state.pending) }));
  };
  const update = (id: string, patch: Partial<PendingMessage>): void => {
    change((all) => all.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };
  const find = (id: string): PendingMessage | undefined =>
    store.getState().pending.find((p) => p.id === id);
  const forget = (id: string): void => {
    timers.get(id)?.();
    timers.delete(id);
    change((all) => all.filter((p) => p.id !== id));
  };
  const fail = (id: string, reason: string): void => {
    timers.get(id)?.();
    timers.delete(id);
    if (find(id) !== undefined) update(id, { delivery: 'failed', reason });
  };

  /** HTTP is the door when the socket is not: the same service, the same id. */
  const overHttp = async (pending: PendingMessage): Promise<void> => {
    try {
      const message = await api.send(pending.channelId, {
        id: pending.id,
        content: pending.content,
        ...(pending.parentId === null ? {} : { parentId: pending.parentId }),
      });
      messageCreated(client, message);
      forget(pending.id);
    } catch (error) {
      fail(pending.id, isApiError(error) ? error.message : 'The message could not be sent.');
    }
  };

  const transmit = (pending: PendingMessage): void => {
    const frame: ClientFrame = {
      id: pending.id,
      op: 'MESSAGE_SEND',
      payload: {
        channelId: pending.channelId,
        content: pending.content,
        ...(pending.parentId === null ? {} : { parentId: pending.parentId }),
      },
    };
    if (connection?.send(frame) !== true) {
      void overHttp(pending);
      return;
    }
    timers.get(pending.id)?.();
    timers.set(
      pending.id,
      schedule(() => {
        timers.delete(pending.id);
        fail(pending.id, 'The server did not answer in time.');
      }, ACK_DEADLINE_MS),
    );
  };

  /** What a reconnect owes: the sends that never got an answer, and a fresh look at what was missed. */
  const resync = (): void => {
    for (const pending of store.getState().pending) {
      if (pending.delivery === 'sending') transmit(pending);
    }
    // A reply missed during the gap is not a root and has no place in the feed's
    // cursor; the counters and the open questions moved without a frame to say so.
    void client.invalidateQueries({ queryKey: families.thread });
    void client.invalidateQueries({ queryKey: families.unresolved });
    void client.invalidateQueries({ queryKey: families.channels });
  };

  /** A replay that was one page: read on from the cursor until the present, then release the channel. */
  const continueReplay = async (channelId: string, from: string): Promise<void> => {
    let cursor: string | null = from;
    try {
      while (cursor !== null) {
        const page = await api.messages(channelId, { after: cursor });
        for (const message of page.data) messageCreated(client, message);
        cursor = page.nextCursor;
      }
      connection?.continuationDone(channelId, from);
    } catch {
      // The connection still holds the cursor: the next reconnect asks again.
    }
  };

  const onFrame = (frame: ServerFrame): void => {
    switch (frame.event) {
      case 'ACK': {
        if (isSendAck(frame)) {
          const id = frame.data.id;
          timers.get(id)?.();
          timers.delete(id);
          if (find(id) !== undefined) update(id, { delivery: 'sent', reason: null });
        } else if ('channels' in frame.data) {
          for (const { channelId, nextCursor } of frame.data.channels) {
            if (nextCursor !== null) void continueReplay(channelId, nextCursor);
          }
        }
        return;
      }
      case 'ERROR': {
        if (frame.refId !== undefined) fail(frame.refId, frame.data.message);
        return;
      }
      case 'MESSAGE_CREATED': {
        messageCreated(client, frame.data);
        forget(frame.data.id);
        return;
      }
      case 'THREAD_UPDATED':
        if (isNewest('thread', frame.data.messageId, frame.version)) {
          threadUpdated(client, frame.data.messageId, frame.data.thread);
        }
        return;
      case 'REACTIONS_UPDATED':
        if (isNewest('reactions', frame.data.messageId, frame.version)) {
          reactionsUpdated(client, frame.data.messageId, frame.data.reactions);
        }
        return;
      case 'CHANNEL_STATE':
        if (isNewest('state', frame.data.channelId, frame.version)) {
          channelStateChanged(client, frame.data.channelId, frame.data.state);
        }
        return;
      case 'CHANNEL_ADDED': {
        const channel: Channel = frame.data;
        channelAdded(client, channel);
        watched.add(channel.id);
        connection?.watch(channel.id);
        return;
      }
      case 'ACCESS_REVOKED': {
        channelsRevoked(client, frame.data.channelIds);
        for (const id of frame.data.channelIds) {
          watched.delete(id);
          connection?.unwatch(id);
        }
        return;
      }
      case 'SESSION_ENDED':
        options.onSessionEnded();
        return;
      case 'PONG':
        return;
    }
  };

  const onStatus = (status: ConnectionStatus): void => {
    store.setState({ status });
    if (status !== 'open') return;
    // The first open is the page loading; every later one is a return from a gap.
    if (opened) resync();
    opened = true;
  };

  const build = (): Connection =>
    createConnection({
      url: options.url,
      openSocket: options.openSocket,
      schedule,
      random: options.random,
      clock: options.clock,
      serverClock,
      checkSession: async () => {
        try {
          await api.me();
          return 'active';
        } catch (error) {
          return isApiError(error) && error.status === 401 ? 'ended' : 'unknown';
        }
      },
      newId: () => messageId(serverClock.now()),
      onFrame,
      onStatus,
    });

  return {
    store,
    start: (): void => {
      if (connection === null) {
        connection = build();
        // Channels asked for before the connection existed are owed to it now.
        for (const id of watched) connection.watch(id);
      }
      connection.start();
    },
    stop: (): void => {
      connection?.stop();
      for (const cancel of timers.values()) cancel();
      timers.clear();
    },
    watch: (channelIds): void => {
      const wanted = new Set(channelIds);
      for (const id of [...watched]) {
        if (!wanted.has(id)) {
          watched.delete(id);
          connection?.unwatch(id);
        }
      }
      for (const id of wanted) {
        if (!watched.has(id)) {
          watched.add(id);
          connection?.watch(id);
        }
      }
    },
    send: ({ channelId, content, parentId }): string => {
      const id = messageId(serverClock.now());
      const pending: PendingMessage = {
        id,
        channelId,
        parentId: parentId ?? null,
        content,
        createdAt: serverClock.now().toISOString(),
        delivery: 'sending',
        reason: null,
      };
      // Painted before anything leaves: the store is what the screen reads.
      change((all) => [...all, pending]);
      transmit(pending);
      return id;
    },
    retry: (id): void => {
      const pending = find(id);
      if (pending?.delivery !== 'failed') return;
      const next: PendingMessage = { ...pending, delivery: 'sending', reason: null };
      update(id, { delivery: 'sending', reason: null });
      transmit(next);
    },
    discard: (id): void => {
      if (find(id)?.delivery === 'failed') forget(id);
    },
  };
};
