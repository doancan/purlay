/**
 * The HTTP surface.
 *
 * Ingress validates, delegates and serialises. It holds no business rule: the
 * layer below never sees an HTTP type, and lint enforces that direction
 * (`ARCHITECTURE.md` §4).
 *
 * **Dependencies are arguments, and they arrived with the first route that needed
 * them.** Until sign-in existed the application took none, which is the rule the
 * configuration loader follows: a thing is wired when the feature that needs it
 * is built (D-57). `/health` still touches none of them, which is what keeps
 * liveness answerable while the database is down.
 *
 * **What it returns is the surface the caller uses, not the framework's type.**
 * Left to inference that is the accumulated type of every route, which under
 * `composite` lands in a committed `.d.ts` growing with routes × error branches
 * — 5 KB for six trivial routes when it was measured (`docs/spikes/elysia.md`).
 * Annotating it as the bare `Elysia` does not compile either: the type is
 * invariant in its routes, so a widened annotation is not assignable to itself
 * with one route added. Naming the two methods the composition root and the
 * tests actually call answers both, and leaves nothing above this file depending
 * on which framework is underneath.
 */
import { Elysia, type HTTPHeaders } from 'elysia';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import type { GitHubClient } from '../../modules/auth/github';
import { completeSignIn, signOut, signOutEverywhere, startSignIn, type AuthResponse } from './auth';
import { clearedStateCookie } from './cookies';
import { refusalFor } from './errors';
import {
  createMyWorkspace,
  listMyWorkspaces,
  listWorkspaceMembers,
  readMe,
  readWorkspace,
} from './workspaces';
import { createWorkspaceChannel, joinPublicChannel, listChannels, readChannel } from './channels';
import { postMessage, readHistory } from './messages';
import { inProcessEventBus } from '../../realtime/bus';
import { sessionTopic } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { createSocketHub } from '../../realtime/hub';
import { CLOSE_CODES, MAX_FRAME_BYTES } from '@purlay/types';
import { routeFrame } from '../../realtime/router';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from '../../realtime/rate-limiter';
import { admitSocket } from '../../realtime/upgrade';

export interface Dependencies {
  readonly config: Config;
  /** A `Kysely` or a `Transaction` — indistinguishable here, which is the point (D-46). */
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
}

/**
 * Everything outside ingress may do with the application.
 *
 * `handle` is what a test drives — a real `Request` in, a real `Response` out,
 * with no socket and no port. That is why the tests below are not integration
 * tests: they exercise the actual routing and the actual error handler.
 */
export interface HttpApplication {
  readonly handle: (request: Request) => Promise<Response>;
  /** Starts serving; returns the port bound, which is the OS's choice for `0`. */
  readonly listen: (port: number) => number;
  /** Closes the listener and every open socket. What a test that listened must call. */
  readonly stop: (closeActiveConnections?: boolean) => Promise<unknown>;
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

/** Liveness. Deliberately touches nothing. */
const HEALTH = { status: 'ok' } as const;

/**
 * The only place a handler's decision becomes a framework response.
 *
 * The handlers in `auth.ts` know nothing about the framework, so this is where a
 * cookie and a redirect are applied — once, rather than four times.
 */
const respond = (
  set: { status?: number | string; headers: HTTPHeaders },
  result: AuthResponse,
): string => {
  set.headers['set-cookie'] = [...result.setCookie];
  if (result.location === undefined) {
    set.status = 204;
    return '';
  }
  set.status = 302;
  set.headers.location = result.location;
  return '';
};

export const createApp = (dependencies: Dependencies): HttpApplication => {
  const hub = createSocketHub(dependencies.database, dependencies.clock);
  const bus = inProcessEventBus(hub.deliver);
  const limiter = inProcessRateLimiter(dependencies.clock, SOCKET_FRAME_BUDGET);
  // The transaction boundary both doors share: a new transaction per write, or
  // the caller's when there is one (a test's). D-35, `platform/transactions.ts`.
  const atomically = atomicallyOn(dependencies.database);
  const sending = { ...dependencies, bus, atomically };

  // Server-wide, because that is the one the framework passes on: the per-route
  // option of the same name is silently ignored — measured, a 100 KB frame reached
  // the handler with it set (`docs/spikes/elysia.md`). Over the cap, the server
  // drops the connection before any handler runs. (§5.5)
  const app = new Elysia({ websocket: { maxPayloadLength: MAX_FRAME_BYTES } })
    /**
     * One error handler for the whole surface, so a status is decided in exactly
     * one place. `set.status` rather than a thrown response: a second way to
     * choose a status is a second place for two of them to disagree.
     */
    .onError(({ code, error, set }) => {
      const issues = 'all' in error && Array.isArray(error.all) ? error.all : [];
      const refusal = refusalFor(code, error, issues);
      set.status = refusal.status;
      return refusal.body;
    })
    .get('/health', () => HEALTH)

    .get('/auth/github', async ({ set }) => respond(set, await startSignIn(dependencies)))
    .get('/auth/github/callback', async ({ request, set }) => {
      // Spent whatever happens next: set before the handler runs, so a refusal
      // carries it too — measured, a header set before a throw survives into
      // the error response (#199).
      set.headers['set-cookie'] = clearedStateCookie();
      return respond(set, await completeSignIn(dependencies, request));
    })
    .post('/auth/logout', async ({ request, set }) =>
      respond(set, await signOut({ ...dependencies, bus }, request)),
    )
    .post('/auth/logout-all', async ({ request, set }) =>
      respond(set, await signOutEverywhere({ ...dependencies, bus }, request)),
    )

    .get('/api/me', async ({ request }) => await readMe(dependencies, request))
    .get('/api/workspaces', async ({ request }) => await listMyWorkspaces(dependencies, request))
    .post('/api/workspaces', async ({ request, body, set }) => {
      set.status = 201;
      return await createMyWorkspace(dependencies, request, body);
    })
    .get(
      '/api/workspaces/:workspaceId',
      async ({ request, params }) => await readWorkspace(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/members',
      async ({ request, params }) =>
        await listWorkspaceMembers(dependencies, request, params.workspaceId),
    )

    .get(
      '/api/workspaces/:workspaceId/channels',
      async ({ request, params }) => await listChannels(dependencies, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/channels', async ({ request, params, body, set }) => {
      set.status = 201;
      return await createWorkspaceChannel(dependencies, request, params.workspaceId, body);
    })
    .get(
      '/api/channels/:channelId',
      async ({ request, params }) => await readChannel(dependencies, request, params.channelId),
    )
    .post(
      '/api/channels/:channelId/join',
      async ({ request, params }) =>
        await joinPublicChannel(dependencies, request, params.channelId),
    )

    .get(
      '/api/channels/:channelId/messages',
      async ({ request, params }) => await readHistory(dependencies, request, params.channelId),
    )
    .post('/api/channels/:channelId/messages', async ({ request, params, body, set }) => {
      set.status = 201;
      return await postMessage(sending, request, params.channelId, body);
    })

    /**
     * The socket.
     *
     * `beforeHandle` runs **before the socket is bound** — verified, not assumed
     * (`docs/spikes/elysia.md`) — so a wrong origin and a missing session are
     * refused with a real HTTP status rather than a socket that opens and then
     * closes for a reason the client has to guess at (D-39, §7.2).
     */
    .ws('/ws', {
      beforeHandle: async ({ request, set }) => {
        try {
          await admitSocket(
            {
              database: dependencies.database,
              clock: dependencies.clock,
              appUrl: dependencies.config.APP_URL,
            },
            request,
          );
          return undefined;
        } catch (error) {
          const refusal = refusalFor('UPGRADE', error, []);
          set.status = refusal.status;
          return refusal.body;
        }
      },
      open: async (socket) => {
        const identity = await hub.opened(
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
        // Where the end of this session will be announced, on whichever node.
        if (identity !== undefined) bus.subscribe(sessionTopic(identity.sessionId), socket.id);
      },
      message: async (socket, raw) => {
        const identity = await hub.identity(socket.id);
        if (identity === undefined) {
          // Its session ended before the frame could be answered; the hub has
          // already announced that, or is about to. Nothing here may be served.
          socket.close(CLOSE_CODES.SESSION_ENDED, 'signed-out');
          return;
        }
        for (const reply of await routeFrame(
          {
            database: dependencies.database,
            clock: dependencies.clock,
            bus,
            limiter,
            // The real boundary. D-35: one transaction, published after it returns.
            atomically,
          },
          identity,
          raw,
        )) {
          // Through the hub, so a replay burst is held to the same mark as the
          // bus's fan-out rather than queued without limit.
          hub.deliver(socket.id, reply);
        }
      },
      close: (socket) => {
        bus.forget(socket.id);
        limiter.forget(socket.id);
        hub.closed(socket.id);
      },
    });

  return {
    handle: async (request) => await app.handle(request),
    listen: (port: number): number => {
      app.listen(port);
      const bound = app.server?.port;
      if (bound === undefined) throw new Error('the server did not report the port it bound');
      return bound;
    },
    stop: async (closeActiveConnections) => await app.stop(closeActiveConnections),
  };
};
