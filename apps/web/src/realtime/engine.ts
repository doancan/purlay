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
 * 6. What is in flight is kept in the browser, per person, and comes back after a reload
 *    as `failed` with its Retry (`pending-store.ts`): a send is never dropped, including
 *    by a tab that closed while it waited.
 * 7. **What the server refuses is said, not swallowed.** A `SUBSCRIBE` it will not take, a
 *    replay that cannot be finished, an error that answers nothing the client sent: each
 *    leaves the channels it touches in `degraded`, which the connection bar shows with a
 *    Retry. A channel that is gone for good (`CHANNEL_NOT_FOUND`, `FORBIDDEN`) is let go and
 *    the list asked again, because live updates it will never have are not a state to show.
 *
 * Everything outside the process is an argument (the socket, the timers, the clock,
 * the dice), so a test drives a dropped connection by hand (D-46).
 */
import type { QueryClient } from '@tanstack/react-query';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  messageId,
  TYPING_TTL_MS,
  type Attachment,
  type Channel,
  type ClientFrame,
  type ErrorCode,
  type RevokedReason,
  PRESENCE_GRACE_MS,
  type PresenceChange,
  type ServerFrame,
} from '@purlay/types';
import type { Api } from '../data/api';
import {
  channelAdded,
  channelRenamed,
  incidentChanged,
  channelStateChanged,
  channelsRevoked,
  deepWorkChanged,
  messageCreated,
  messageRevised,
  reactionsUpdated,
  readAgain,
  threadUpdated,
} from '../data/cache';
import type { ClientStorage } from '../data/browser-storage';
import { codeOf, type FailureCode } from '../data/failure';
import { isApiError } from '../data/errors';
import { families, keys } from '../data/keys';
import type { Clock } from './clock';
import {
  createConnection,
  type Connection,
  type ConnectionStatus,
  type OpenSocket,
  type Schedule,
} from './connection';
import { loadStored, saveStored, type StoredMessage } from './pending-store';
import { createServerClock } from './server-clock';

/** How long a send may wait for its ACK before it is shown as failed (`UX.md` §3.1). */
export const ACK_DEADLINE_MS = 3_000;

/**
 * Why a send can fail without the server ever having it: no answer at all from the HTTP door — the
 * network, or a proxy's 502/503/504 while the API is down. Such a send is still pending in truth, and
 * a reconnect sends it again (`ARCHITECTURE.md` §5.3). A timeout, or anything the server said, stays
 * failed for the person: §5.3's "Retry" is theirs.
 */
const UNREACHED: ReadonlySet<FailureCode> = new Set<FailureCode>(['NETWORK']);

/**
 * How long a replay continuation waits before it asks again, and so how many times it tries:
 * one more attempt after each wait. Capped — a feed with a hole in it is better refetched
 * whole than chased forever — and short, because the person is looking at the channel.
 */
export const REPLAY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/** Refused for a reason waiting will not change: the channel is gone, or the person lost it. */
const PERMANENT: ReadonlySet<string> = new Set(['CHANNEL_NOT_FOUND', 'FORBIDDEN']);

/** The `degraded` key for an error that answers nothing the client can name. */
export const UNNAMED = '*';

/** What a channel in `degraded` was refused for: the server's code, or `REPLAY` for a gap that could not be filled. */
export type DegradedReason = ErrorCode | 'REPLAY';

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
  /** Why it failed, as a code a screen turns into words (`data/failure.ts`); null while it has not. */
  readonly reason: FailureCode | null;
  /** The uploads it carries, drawn on its row before the server has it (D-109 §7). */
  readonly attachments: readonly Attachment[];
}

export interface RealtimeState {
  readonly status: ConnectionStatus;
  /**
   * The connection has been open at least once on this page. Kept here, where the status changes,
   * and not inferred by a screen from the statuses it happened to draw: open and lost between two
   * renders is still a connection that was open and is lost (#347).
   */
  readonly connectedOnce: boolean;
  readonly pending: readonly PendingMessage[];
  /** Channels whose live updates are not trustworthy right now, by what went wrong. */
  readonly degraded: Readonly<Record<string, DegradedReason>>;
  /**
   * Who is typing, by channel, in the order they began; a channel nobody is typing in is absent.
   * Never the person themselves. Forgotten when the announcement runs out or their message
   * arrives (#411).
   */
  readonly typing: Readonly<Record<string, readonly string[]>>;
  /**
   * Who is online, by person, at the version that said so (D-136): the largest heard wins, so a frame
   * that arrives late cannot undo a newer one, nor a snapshot read before a change undo the change.
   * A person not here is unknown — drawn as nothing, never as offline.
   */
  readonly presence: Readonly<
    Record<string, { readonly online: boolean; readonly version: number }>
  >;
  /**
   * Rises when what a workspace's presence was read as may have gone stale: a grace after a
   * reconnect, when a node that restarted knows its people again (D-136 §4). Until then what was
   * known is kept — a restart does not show the team offline.
   */
  readonly presenceEpoch: number;
  /**
   * Channels that went away and why, when the server said (D-123): what a screen still showing one
   * tells the person instead of "not found".
   */
  readonly gone: Readonly<Record<string, RevokedReason>>;
  /**
   * The last time unsent messages went with a channel the person lost (#521): how many, and a number
   * that rises each time, so a notice says it once per loss. Null until it first happens.
   */
  readonly lost: { readonly count: number; readonly seq: number } | null;
}

export interface Outgoing {
  readonly channelId: string;
  readonly content: string;
  readonly parentId?: string | undefined;
  readonly attachments?: readonly Attachment[] | undefined;
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
  /** Whose messages these are: what is kept for a reload is kept for this person alone. */
  readonly userId: string;
  /** Where unsent messages are kept; absent, nothing is. */
  readonly storage?: ClientStorage | null;
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
  /** Asks again for every channel whose live updates were refused or interrupted. */
  readonly retryDegraded: () => void;
  /**
   * The person is typing in this channel. Said over an open socket and nowhere else, at most once
   * per half of `TYPING_TTL_MS` per channel — the server's own ration, so nothing is sent that it
   * would drop (D-114).
   */
  readonly announceTyping: (channelId: string) => void;
  /**
   * Channels the person lost without being told — gone from a list read again, as after a time
   * offline: their unsent messages go, as they do on `ACCESS_REVOKED` (#521).
   */
  readonly lose: (channelIds: readonly string[]) => void;
  /** What a frame or a workspace's snapshot says of who is online (D-136); older than known is kept out. */
  readonly applyPresence: (changes: readonly PresenceChange[]) => void;
  /** These people's presence is no longer known: drawn as nothing until something is heard. */
  readonly forgetPresence: (userIds: readonly string[]) => void;
}

const isSendAck = (
  frame: ServerFrame,
): frame is Extract<ServerFrame, { event: 'ACK' }> & {
  data: { id: string };
} => frame.event === 'ACK' && 'id' in frame.data;

export const createEngine = (options: EngineOptions): Engine => {
  const { api, client, schedule } = options;
  const storage = options.storage ?? null;
  // What a reload interrupted comes back as failed: it may have reached the server or not,
  // and Retry — the same id — is right either way (D-8).
  const restored: PendingMessage[] = loadStored(storage, options.userId).map((m) => ({
    ...m,
    delivery: 'failed',
    reason: null,
    attachments: m.attachments ?? [],
  }));
  const store = createStore<RealtimeState>(() => ({
    status: 'idle',
    connectedOnce: false,
    pending: restored,
    degraded: {},
    typing: {},
    presence: {},
    presenceEpoch: 0,
    gone: {},
    lost: null,
  }));
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
  // A stop that left sends waiting: the next open owes them what a reconnect owes.
  let resumeOnOpen = false;
  // Moves on every stop, so a continuation that was asleep when the page stopped does not wake into a dead engine.
  let epoch = 0;
  const wakers = new Set<() => void>();
  const continuing = new Set<string>();
  // Subscribe frames the connection has already reported as refused, so the ERROR that follows is not reported twice.
  const reported = new Set<string>();

  const persist = (pending: readonly PendingMessage[]): void => {
    const keep: StoredMessage[] = pending
      .filter((p) => p.delivery !== 'sent')
      .map(({ id, channelId, parentId, content, createdAt, attachments }) => ({
        id,
        channelId,
        parentId,
        content,
        createdAt,
        attachments,
      }));
    saveStored(storage, options.userId, keep);
  };

  const change = (
    edit: (pending: readonly PendingMessage[]) => readonly PendingMessage[],
  ): void => {
    store.setState((state) => ({ pending: edit(state.pending) }));
    persist(store.getState().pending);
  };

  const degrade = (channelIds: readonly string[], reason: DegradedReason): void => {
    store.setState((state) => ({
      degraded: { ...state.degraded, ...Object.fromEntries(channelIds.map((id) => [id, reason])) },
    }));
  };
  const recover = (channelId: string): void => {
    if (!(channelId in store.getState().degraded)) return;
    store.setState((state) => ({
      degraded: Object.fromEntries(
        Object.entries(state.degraded).filter(([id]) => id !== channelId),
      ),
    }));
  };
  // Each typist's end, by channel and person, so a renewed announcement replaces the old end.
  const typingEnds = new Map<string, () => void>();
  const typingKey = (channelId: string, userId: string): string => `${channelId}:${userId}`;
  /** Drops what was remembered about why these channels went away (D-123). */
  const forgetWhyGone = (channelIds: readonly string[]): void => {
    const now = store.getState().gone;
    if (!channelIds.some((id) => id in now)) return;
    store.setState({
      gone: Object.fromEntries(Object.entries(now).filter(([id]) => !channelIds.includes(id))),
    });
  };

  const stopTyping = (channelId: string, userId: string): void => {
    const key = typingKey(channelId, userId);
    typingEnds.get(key)?.();
    typingEnds.delete(key);
    const now = store.getState().typing[channelId];
    if (now?.includes(userId) !== true) return;
    const rest = now.filter((id) => id !== userId);
    store.setState((state) => ({
      typing: Object.fromEntries(
        Object.entries({ ...state.typing, [channelId]: rest }).filter(([, ids]) => ids.length > 0),
      ),
    }));
  };
  const startTyping = (channelId: string, userId: string, ttlMs: number): void => {
    if (userId === options.userId) return;
    const key = typingKey(channelId, userId);
    typingEnds.get(key)?.();
    typingEnds.set(
      key,
      schedule(() => {
        stopTyping(channelId, userId);
      }, ttlMs),
    );
    const now = store.getState().typing[channelId] ?? [];
    if (now.includes(userId)) return;
    store.setState((state) => ({ typing: { ...state.typing, [channelId]: [...now, userId] } }));
  };
  // The last announcement this person made in each channel: its frame id, and when, by this clock.
  const announced = new Map<string, { readonly id: string; readonly at: number }>();
  const isAnnouncement = (refId: string): boolean =>
    [...announced.values()].some((last) => last.id === refId);
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
  /**
   * A channel the person lost takes its unsent messages with it: nothing could send them, and kept
   * they would sit in storage with no screen that shows them (#521). Said once, with how many.
   */
  const drop = (doomed: readonly PendingMessage[]): void => {
    if (doomed.length === 0) return;
    const ids = new Set(doomed.map((p) => p.id));
    for (const id of ids) {
      timers.get(id)?.();
      timers.delete(id);
    }
    change((all) => all.filter((p) => !ids.has(p.id)));
    const seq = (store.getState().lost?.seq ?? 0) + 1;
    store.setState({ lost: { count: ids.size, seq } });
  };
  const dropUnsent = (channelIds: readonly string[]): void => {
    drop(store.getState().pending.filter((p) => channelIds.includes(p.channelId)));
  };
  const fail = (id: string, reason: FailureCode): void => {
    // The channel is gone: no retry can send it, and no screen shows it (#521).
    const failing = find(id);
    if (reason === 'CHANNEL_NOT_FOUND' && failing !== undefined) {
      drop([failing]);
      return;
    }
    timers.get(id)?.();
    timers.delete(id);
    if (find(id) !== undefined) update(id, { delivery: 'failed', reason });
  };

  /** The ids a send names, on either door; none when it carries nothing. */
  const carried = (pending: PendingMessage): { attachmentIds?: string[] } =>
    pending.attachments.length === 0
      ? {}
      : { attachmentIds: pending.attachments.map((attachment) => attachment.id) };

  /** HTTP is the door when the socket is not: the same service, the same id. */
  const overHttp = async (pending: PendingMessage): Promise<void> => {
    try {
      const message = await api.send(pending.channelId, {
        id: pending.id,
        content: pending.content,
        ...(pending.parentId === null ? {} : { parentId: pending.parentId }),
        ...carried(pending),
      });
      messageCreated(client, message);
      forget(pending.id);
    } catch (error) {
      fail(pending.id, codeOf(error));
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
        ...carried(pending),
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
        fail(pending.id, 'TIMEOUT');
      }, ACK_DEADLINE_MS),
    );
  };

  /**
   * What a reconnect owes: the sends that never got an answer — those still on their way, and those
   * the server never had, which the bar promised would send when it was back — and a fresh look at
   * what was missed. A timeout or a refusal stays failed, for the person.
   */
  const resync = (): void => {
    for (const pending of store.getState().pending) {
      if (pending.delivery === 'sending') {
        transmit(pending);
      } else if (pending.reason !== null && UNREACHED.has(pending.reason)) {
        update(pending.id, { delivery: 'sending', reason: null });
        transmit({ ...pending, delivery: 'sending', reason: null });
      }
    }
    // A reply missed during the gap is not a root and has no place in the feed's
    // cursor; the counters and the open questions moved without a frame to say so.
    void client.invalidateQueries({ queryKey: families.thread });
    void client.invalidateQueries({ queryKey: families.unresolved });
    void client.invalidateQueries({ queryKey: families.channels });
    // An incident moved while away (D-137): its frame went to a socket that was down.
    void client.invalidateQueries({ queryKey: families.incident });
    // A workspace's name, the person's role or Deep Work changed elsewhere reach this tab as frames on
    // the person's own topic, which a socket that was down never hears (D-124).
    void client.invalidateQueries({ queryKey: keys.me });
    // And a profile changed while away (D-131), which no frame will now say.
    void client.invalidateQueries({ queryKey: families.members });
  };

  /** Waits on the injected schedule; false when the page stopped meanwhile. */
  const sleep = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const cancel = schedule(() => {
        wakers.delete(wake);
        resolve(true);
      }, ms);
      const wake = (): void => {
        cancel();
        resolve(false);
      };
      wakers.add(wake);
    });

  /** One pass over the pages from a cursor to the present. */
  const readThrough = async (channelId: string, from: string): Promise<void> => {
    let cursor: string | null = from;
    while (cursor !== null) {
      const page = await api.messages(channelId, { after: cursor });
      for (const message of page.data) messageCreated(client, message);
      cursor = page.nextCursor;
    }
  };

  /**
   * A replay that was one page: read on from the cursor until the present, then release the
   * channel. A failure is tried again after a wait, a few times; if it still fails the feed
   * has a hole the cursor cannot be trusted to fill, so the channel's messages are asked for
   * whole, from the server, and the channel is shown as degraded until that is done. One
   * continuation per channel at a time: a second `ACK` for the same one does not start a
   * parallel read.
   */
  const continueReplay = async (channelId: string, from: string): Promise<void> => {
    if (continuing.has(channelId)) return;
    continuing.add(channelId);
    const mine = epoch;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await readThrough(channelId, from);
          if (mine !== epoch) return;
          connection?.continuationDone(channelId, from);
          recover(channelId);
          return;
        } catch {
          if (mine !== epoch) return;
          const wait = REPLAY_RETRY_DELAYS_MS[attempt];
          if (wait === undefined) break;
          if (!(await sleep(wait)) || mine !== epoch) return;
        }
      }
      degrade([channelId], 'REPLAY');
      void client.invalidateQueries({ queryKey: keys.messages(channelId) });
    } finally {
      continuing.delete(channelId);
    }
  };

  /** A `SUBSCRIBE` the server will not take: said, and for a channel that is gone, let go. */
  const refused = (channelIds: readonly string[], code: ErrorCode): void => {
    if (PERMANENT.has(code)) {
      dropUnsent(channelIds);
      // Refused, so never subscribed: let go without a frame (#523).
      connection?.forget(channelIds);
      for (const id of channelIds) {
        watched.delete(id);
        recover(id);
      }
      void client.invalidateQueries({ queryKey: families.channels });
      return;
    }
    degrade(channelIds, code);
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
            // Messages are replayed from a cursor; a reaction, a resolution or an edit on a message
            // already held is not. A feed read before this answer may hold a state that changed
            // between its read and the server beginning to send, and nothing would ever say so
            // (found in a browser: a reaction taken back in that gap stayed on the other screen).
            // Read again, what is cached for the channel is correct from this moment on.
            readAgain(client, keys.messages(channelId));
            // A file sent, or its message deleted, in the gap is in no frame either (D-129).
            readAgain(client, keys.files(channelId));
            readAgain(client, keys.pins(channelId));
          }
          // Threads are cached by their root, which names no channel: every one that is held.
          readAgain(client, families.thread);
        }
        return;
      }
      case 'ERROR': {
        const { refId } = frame;
        if (refId !== undefined && isAnnouncement(refId)) {
          // An announcement the server would not take — the channel went, or the budget is spent —
          // costs the room a hint and nothing else; the channel itself is told by its own frames.
        } else if (refId !== undefined && find(refId) !== undefined) {
          fail(refId, frame.data.code);
        } else if (refId !== undefined && reported.delete(refId)) {
          // A refused subscription the connection already told us about.
        } else if (
          frame.data.code === 'RATE_LIMITED' ||
          frame.data.code === 'DATABASE_UNAVAILABLE'
        ) {
          // The connection sends the chunk again after a wait; nothing is lost yet.
        } else {
          // An error that answers nothing the client can name must still not be silent.
          degrade([UNNAMED], frame.data.code);
        }
        return;
      }
      case 'MESSAGE_CREATED': {
        messageCreated(client, frame.data);
        forget(frame.data.id);
        // What they were typing has arrived; an event was typed by nobody.
        if (frame.data.sender !== null) stopTyping(frame.data.channelId, frame.data.sender.id);
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
      case 'MESSAGE_REVISED':
        if (isNewest('revision', frame.data.messageId, frame.version)) {
          messageRevised(client, frame.data);
        }
        return;
      case 'CHANNEL_STATE':
        if (isNewest('state', frame.data.channelId, frame.version)) {
          channelStateChanged(client, frame.data.channelId, frame.data.state);
        }
        return;
      case 'CHANNEL_UPDATED':
        if (isNewest('channel', frame.data.channelId, frame.version)) {
          channelRenamed(client, frame.data.channelId, frame.data);
        }
        return;
      case 'CHANNEL_ADDED': {
        const channel: Channel = frame.data;
        channelAdded(client, channel);
        // Given back, it forgets why it went: a later removal must not read as the old reason.
        forgetWhyGone([channel.id]);
        watched.add(channel.id);
        connection?.watch(channel.id);
        return;
      }
      case 'ACCESS_REVOKED': {
        channelsRevoked(client, frame.data.channelIds);
        dropUnsent(frame.data.channelIds);
        const { reason } = frame.data;
        if (reason === undefined) forgetWhyGone(frame.data.channelIds);
        else {
          const gone = { ...store.getState().gone };
          for (const id of frame.data.channelIds) gone[id] = reason;
          store.setState({ gone });
        }
        // A public channel left is still there to see and join again: the list is read again.
        if (reason === 'left') void client.invalidateQueries({ queryKey: families.channels });
        // The server dropped these as it sent this: let go without a frame (#523).
        connection?.forget(frame.data.channelIds);
        for (const id of frame.data.channelIds) {
          watched.delete(id);
          for (const userId of store.getState().typing[id] ?? []) stopTyping(id, userId);
        }
        return;
      }
      case 'DEEP_WORK_UPDATED':
        deepWorkChanged(client, frame.data.workspaceId, frame.data.until);
        return;
      case 'SESSION_ENDED':
        options.onSessionEnded();
        return;
      case 'PINS_UPDATED':
        // No state in the frame (D-130): the channel's pins are read again, wherever they are shown.
        readAgain(client, keys.pins(frame.data.channelId));
        return;
      case 'INCIDENT_UPDATED':
        incidentChanged(client, frame.data.channelId);
        return;
      case 'MESSAGE_VERSIONS_UPDATED':
        // A version removed (D-135 §5): an open history is read again, and the words leave it.
        readAgain(client, keys.messageVersions(frame.data.messageId));
        return;
      case 'CHANNELS_UPDATED':
        // No state in the frame (D-132): the person's channels here are read again.
        void client.invalidateQueries({ queryKey: keys.channels(frame.data.workspaceId) });
        return;
      case 'SAVED_UPDATED':
        // No state in the frame (D-128): what is saved is read again, in every view of it.
        void client.invalidateQueries({ queryKey: keys.saved(frame.data.workspaceId) });
        return;
      case 'WORKSPACE_UPDATED':
        // No state in the frame (D-124): the memberships are read again, newest wins — and the
        // workspace's members, whose profiles it also says changed (D-131).
        void client.invalidateQueries({ queryKey: keys.me });
        void client.invalidateQueries({ queryKey: keys.members(frame.data.workspaceId) });
        return;
      case 'TYPING':
        startTyping(frame.data.channelId, frame.data.userId, frame.data.ttlMs);
        return;
      case 'PRESENCE':
        applyPresence(frame.data.changes);
        return;
      case 'PONG':
        return;
    }
  };

  const applyPresence = (changes: readonly PresenceChange[]): void => {
    const now = store.getState().presence;
    const newer = changes.filter((change) => (now[change.userId]?.version ?? -1) < change.version);
    if (newer.length === 0) return;
    const next = { ...now };
    for (const change of newer) {
      next[change.userId] = { online: change.online, version: change.version };
    }
    store.setState({ presence: next });
  };

  /** The read of who is online a grace after a reconnect, while it waits. */
  let rereadPresence: (() => void) | null = null;
  /** Forgetting who is online, a grace into a gap: what was heard before it is no longer known. */
  let forgetPresence: (() => void) | null = null;

  const onStatus = (status: ConnectionStatus): void => {
    store.setState(status === 'open' ? { status, connectedOnce: true } : { status });
    if (status !== 'open') {
      // A gap longer than the grace has missed whoever left in it: nothing is drawn, rather than the
      // last thing heard believed for an hour. A short one keeps what it knew (D-136 §4).
      if (opened && forgetPresence === null) {
        forgetPresence = schedule(() => {
          forgetPresence = null;
          store.setState({ presence: {} });
        }, PRESENCE_GRACE_MS);
      }
      return;
    }
    forgetPresence?.();
    forgetPresence = null;
    // The first open is the page loading; every later one is a return from a gap.
    if (opened || resumeOnOpen) {
      resync();
      // Who is online is read again once the people who were on a restarted node are back on it:
      // once, a grace after the last of several reconnects, and never after the engine stopped.
      rereadPresence?.();
      rereadPresence = schedule(() => {
        rereadPresence = null;
        store.setState((state) => ({ presenceEpoch: state.presenceEpoch + 1 }));
      }, PRESENCE_GRACE_MS);
    }
    resumeOnOpen = false;
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
      onSubscribeRefused: (channelIds, code, refId) => {
        reported.add(refId);
        refused(channelIds, code);
      },
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
      rereadPresence?.();
      rereadPresence = null;
      forgetPresence?.();
      forgetPresence = null;
      for (const cancel of timers.values()) cancel();
      timers.clear();
      // Who was typing is not known while nothing is heard; the next announcement says again.
      announced.clear();
      for (const cancel of typingEnds.values()) cancel();
      typingEnds.clear();
      store.setState({ typing: {} });
      // Continuations asleep between attempts wake and end; the epoch tells a running one it is stale.
      epoch += 1;
      for (const wake of [...wakers]) wake();
      wakers.clear();
      continuing.clear();
      // A send still waiting has lost its deadline timer with the rest: the next open owes it a re-send.
      resumeOnOpen = store.getState().pending.some((p) => p.delivery === 'sending');
    },
    watch: (channelIds): void => {
      const wanted = new Set(channelIds);
      const dropped = [...watched].filter((id) => !wanted.has(id));
      for (const id of dropped) watched.delete(id);
      // One frame for all of them, not one each (#523).
      if (dropped.length > 0) connection?.unwatch(dropped);
      for (const id of wanted) {
        if (!watched.has(id)) {
          watched.add(id);
          connection?.watch(id);
        }
      }
    },
    send: ({ channelId, content, parentId, attachments }): string => {
      // What they were typing is on its way; the next keystroke is news again, as on the server.
      announced.delete(channelId);
      const id = messageId(serverClock.now());
      const pending: PendingMessage = {
        id,
        channelId,
        parentId: parentId ?? null,
        content,
        createdAt: serverClock.now().toISOString(),
        delivery: 'sending',
        reason: null,
        attachments: attachments ?? [],
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
    applyPresence,
    forgetPresence: (userIds): void => {
      const now = store.getState().presence;
      if (!userIds.some((userId) => userId in now)) return;
      const gone = new Set(userIds);
      store.setState({
        presence: Object.fromEntries(Object.entries(now).filter(([userId]) => !gone.has(userId))),
      });
    },
    lose: (channelIds): void => {
      dropUnsent(channelIds);
    },
    announceTyping: (channelId): void => {
      if (connection === null) return;
      const now = options.clock.now().getTime();
      const last = announced.get(channelId);
      if (last !== undefined && now - last.at < TYPING_TTL_MS / 2) return;
      const id = messageId(serverClock.now());
      // Only over an open socket: a frame that did not leave is not kept, nor sent over HTTP.
      if (connection.send({ id, op: 'TYPING', payload: { channelId } })) {
        announced.set(channelId, { id, at: now });
      }
    },
    retryDegraded: (): void => {
      const stale = Object.keys(store.getState().degraded).filter((id) => id !== UNNAMED);
      store.setState({ degraded: {} });
      // Unwatched and watched again, the channel is subscribed from its cursor as if new.
      const again = stale.filter((id) => watched.has(id));
      connection?.unwatch(again);
      for (const id of again) connection?.watch(id);
      void client.invalidateQueries({ queryKey: families.channels });
    },
  };
};
