/**
 * The socket door's lifecycle: who may open one, what happens when one opens,
 * a frame arrives and it closes.
 *
 * `app.ts` is the composition root and names the routes; the behaviour behind
 * `/ws` is here, so that file reads as composition and this one as the lifecycle.
 * The functions take structural views of the framework's socket rather than its
 * type, for the reason `app.ts` returns a narrow application: an application's
 * type is invariant in its routes, so nothing about a route group can be passed
 * around, but plain functions can (`docs/spikes/elysia.md`).
 *
 * Unchanged in what it does: admission is decided **before the socket is bound**
 * (D-39, `ARCHITECTURE.md` §7.2), identity is resolved once on open, frames of one
 * connection are handled in order, and cleanup runs on close.
 */
import { CLOSE_CODES, type ServerFrame } from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { channelTopic, sessionTopic, userTopic, type EventBus } from '../../platform/events';
import { withinRequest, type Logger } from '../../platform/logging';
import { atomicallyOn, type Atomically } from '../../platform/transactions';
import { inProcessBackplane, type Backplane } from '../../realtime/bus';
import { createSocketHub } from '../../realtime/hub';
import {
  inProcessRateLimiter,
  SOCKET_CONNECTION_LIMITS,
  SOCKET_FRAME_BUDGET,
  type RateLimiter,
} from '../../realtime/rate-limiter';
import { routeFrame } from '../../realtime/router';
import { admitSocket } from '../../realtime/upgrade';
import { AppError } from '../../platform/errors';
import { refusalFor } from '../http/errors';

export interface SocketDependencies {
  readonly config: Pick<Config, 'APP_URL'>;
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly backplane?: Backplane | undefined;
  /** The per-user write bucket, shared with HTTP's. */
  readonly userWrites: RateLimiter;
  /** Defaults to `SOCKET_CONNECTION_LIMITS`; a test that cannot open two thousand passes less. */
  readonly connectionLimits?: ConnectionLimits | undefined;
}

export interface ConnectionLimits {
  readonly perUser: number;
  readonly total: number;
}

/** What the lifecycle reads of the framework's socket. */
interface SocketHandle {
  readonly id: string;
  readonly raw: object & { readonly send: (payload: string) => number };
  readonly data: { readonly request: Request };
  readonly close: (code: number, reason: string) => unknown;
}

/** A refusal at the upgrade: the HTTP status and body the handshake answers with. */
interface UpgradeRefusal {
  readonly status: number;
  readonly body: unknown;
}

export interface HeldByConnections {
  readonly connections: number;
  readonly busSockets: number;
  readonly busTopics: number;
  readonly rateBuckets: number;
}

export interface SocketLifecycle {
  /** The bus this node publishes through — the HTTP write path publishes to it too. */
  readonly bus: EventBus;
  /** The transaction boundary both doors share (D-35). */
  readonly atomically: Atomically;
  /** `undefined` admits the upgrade; otherwise the refusal to answer with. */
  readonly admit: (request: Request) => Promise<UpgradeRefusal | undefined>;
  readonly open: (socket: SocketHandle) => Promise<void>;
  readonly message: (socket: SocketHandle, raw: unknown) => void;
  readonly close: (socket: SocketHandle, code: number) => void;
  /** Tells every socket to come back, and resolves when the frames being handled are done. */
  readonly closeAll: () => void;
  readonly settled: () => Promise<void>;
  readonly held: () => HeldByConnections;
}

/**
 * How much a socket has queued and not yet written, read from Bun's own socket.
 *
 * Bun has it — measured (#197) — and the framework's copy of the socket's type
 * does not declare it. Checked rather than cast: if a runtime ever lacks it, the
 * first connection refuses loudly instead of every connection running with no
 * backpressure at all.
 */
const outboundBufferOf = (raw: object): (() => number) => {
  const read: unknown = Reflect.get(raw, 'getBufferedAmount');
  if (typeof read !== 'function') {
    throw new Error('the socket cannot report its outbound buffer, so backpressure cannot be held');
  }
  return () => {
    const amount: unknown = Reflect.apply(read, raw, []);
    // Unreadable is treated as full: the safe failure is a resync, not an
    // unbounded queue.
    return typeof amount === 'number' ? amount : Number.POSITIVE_INFINITY;
  };
};

export const createSocketLifecycle = (dependencies: SocketDependencies): SocketLifecycle => {
  const { log, database, clock } = dependencies;
  const limits = dependencies.connectionLimits ?? SOCKET_CONNECTION_LIMITS;
  const hub = createSocketHub(database, clock, {
    log,
    // Called from `hub.deliver`, which only runs after `bus` exists.
    leave: (channelId, socketId) => {
      bus.unsubscribe(channelTopic(channelId), socketId);
    },
    // Where the end of this session, of the account, or of one membership is
    // announced, on whichever node — subscribed before the session is confirmed.
    listen: (identity) => {
      bus.subscribe(sessionTopic(identity.sessionId), identity.socketId);
      bus.subscribe(userTopic(identity.userId), identity.socketId);
    },
  });
  const bus = (dependencies.backplane ?? inProcessBackplane()).node(hub.deliver, log);
  const limiter = inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET);
  // The transaction boundary both doors share: a new transaction per write, or
  // the caller's when there is one (a test's). D-35, `platform/transactions.ts`.
  const atomically = atomicallyOn(database);

  return {
    bus,
    atomically,

    admit: async (request): Promise<UpgradeRefusal | undefined> => {
      try {
        const { userId } = await admitSocket(
          { database, clock, appUrl: dependencies.config.APP_URL },
          request,
        );
        // Before the socket is bound, so a refusal is a real status. Counts what is
        // open now; sockets still opening are counted again when they are bound
        // (`open`), which is what makes the cap hold under a burst of upgrades.
        if (hub.size() >= limits.total) {
          throw new AppError({
            code: 'DATABASE_UNAVAILABLE',
            message: 'The service is busy. Try again shortly.',
          });
        }
        if (hub.connectionsOf(userId) >= limits.perUser) {
          throw new AppError({
            code: 'RATE_LIMITED',
            message: 'Too many connections are open for this account.',
          });
        }
        return undefined;
      } catch (error) {
        return refusalFor('UPGRADE', error, []);
      }
    },

    open: async (socket): Promise<void> => {
      let identity: Awaited<ReturnType<typeof hub.opened>>;
      try {
        identity = await hub.opened(
          socket.id,
          {
            // The raw socket's answers, not the framework wrapper's: whether a
            // frame was dropped and how much is queued (#197).
            send: (payload) => socket.raw.send(payload),
            buffered: outboundBufferOf(socket.raw),
            close: (code, reason) => {
              socket.close(code, reason);
            },
          },
          socket.data.request,
        );
      } catch (error) {
        // The identity read failed after the upgrade was admitted. Left to throw, the
        // framework answers with a raw `{"error":…}` body that is not a frame, which
        // a client takes for a malformed one and reconnects into at once. Say it in
        // the contract and close with the code that says why.
        log.error('socket failed to open', { socketId: socket.id, err: error });
        const refusal = refusalFor('UPGRADE', error, []);
        const frame: ServerFrame = {
          event: 'ERROR',
          data: refusal.body.error,
          ts: clock.now().getTime(),
        };
        socket.raw.send(JSON.stringify(frame));
        socket.close(
          refusal.status === 503 ? CLOSE_CODES.TOO_BUSY : CLOSE_CODES.INTERNAL,
          'failed-to-open',
        );
        return;
      }
      // The upgrade checks what is open; a burst of upgrades all pass that check
      // before any is counted, so the cap is enforced again here, on the count
      // that includes this connection.
      if (identity !== undefined && hub.connectionsOf(identity.userId) > limits.perUser) {
        log.warn('socket refused: too many open for this account', { socketId: socket.id });
        socket.close(CLOSE_CODES.TOO_BUSY, 'too-many-connections');
        return;
      }
      if (identity !== undefined) {
        log.info('socket opened', { socketId: socket.id, userId: identity.userId });
      }
    },

    message: (socket, raw): void => {
      // In order, one at a time, per connection: the framework starts a handler
      // per frame and does not wait for the last one.
      hub.enqueue(socket.id, async () => {
        const identity = await hub.identity(socket.id);
        if (identity === undefined) {
          // Its session ended before the frame could be answered; the hub has
          // already announced that, or is about to. Nothing here may be served.
          socket.close(CLOSE_CODES.SESSION_ENDED, 'signed-out');
          return;
        }
        // Each frame is a request of its own: its own id on every line it writes.
        await withinRequest(
          { requestId: crypto.randomUUID(), startedAt: performance.now() },
          async () => {
            let replies: readonly ServerFrame[] = [];
            try {
              replies = await routeFrame(
                {
                  database,
                  clock,
                  bus,
                  limiter,
                  userWrites: dependencies.userWrites,
                  log,
                  // The real boundary. D-35: one transaction, published after it returns.
                  atomically,
                  socket: hub,
                },
                identity,
                raw,
              );
            } finally {
              // Through the hub, so a replay burst is held to the same mark as the
              // bus's fan-out, and the live frames kept during a subscription follow.
              hub.reply(socket.id, replies);
            }
          },
        );
      });
    },

    close: (socket, code): void => {
      log.info('socket closed', { socketId: socket.id, code });
      bus.forget(socket.id);
      limiter.forget(socket.id);
      hub.closed(socket.id);
    },

    closeAll: (): void => {
      hub.closeAll(CLOSE_CODES.RESTARTING, 'restarting');
    },
    settled: async (): Promise<void> => {
      await hub.settled();
    },

    held: () => ({
      connections: hub.size(),
      busSockets: bus.size().sockets,
      busTopics: bus.size().topics,
      rateBuckets: limiter.held(),
    }),
  };
};
