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
import { clearedStateCookie } from '../../platform/cookies';
import { clientAddress, peerOf } from './client-address';
import { httpLimits, WRITE_BUDGET, type HttpBudgets } from './rate-limit';
import { inProcessRateLimiter } from '../../realtime/rate-limiter';
import { AppError } from '../../platform/errors';
import {
  JSON_BODY_MAX_BYTES,
  crossSiteResponse,
  inboundRequestId,
  bodyRefusal,
  edgeRefusalResponse,
  hasUnsupportedMediaType,
  isUploadRequest,
  uploadRefusal,
  isCrossSiteMutation,
  unsupportedMediaTypeResponse,
  responseHeaders,
  DOCUMENT_HEADERS,
} from './edge';
import { clientFileFor, isUnchanged, type Client } from './client';
import { refusalFor } from './errors';
import {
  createMyWorkspace,
  listMyWorkspaces,
  setMyDeepWork,
  listWorkspaceMembers,
  removeWorkspaceMember,
  updateMemberRole,
  readMe,
  readWorkspace,
} from './workspaces';
import {
  createWorkspaceChannel,
  joinPublicChannel,
  listChannels,
  openDirectMessageWith,
  readChannel,
  readUpTo,
  setLevel,
  addChannelMember,
} from './channels';
import { markNotificationsRead, readInbox } from './notifications';
import {
  postMessage,
  readHistory,
  readThread,
  readSearch,
  readUnresolved,
  setThreadResolution,
  editMessage,
  removeMessage,
} from './messages';
import { changeReaction } from './reactions';
import { readiness } from '../../platform/readiness';
import { currentRequest, enterRequest, type Logger } from '../../platform/logging';
import { ATTACHMENT_BYTES_MAX, MAX_FRAME_BYTES } from '@purlay/types';
import type { Backplane } from '../../realtime/bus';
import type { ObjectStore } from '../../platform/storage';
import { createSocketLifecycle, type ConnectionLimits, type HeldByConnections } from '../ws/socket';
import { receiveUpload } from './uploads';
import { discardAttachment, downloadAttachment } from './attachments';

export interface Dependencies {
  readonly config: Config;
  /** A `Kysely` or a `Transaction` — indistinguishable here, which is the point (D-46). */
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
  /** Where attachment bytes live (D-109); the unconfigured store refuses every use, loudly. */
  readonly storage: ObjectStore;
  readonly log: Logger;
  /** Absent in production, where the limits are the provisional ones (`rate-limit.ts`). */
  readonly rateBudgets?: HttpBudgets;
  /** Absent in production, where the limits are the provisional ones (`rate-limiter.ts`). */
  readonly connectionLimits?: ConnectionLimits;
  /**
   * The transport this node publishes through. One node needs none: it makes its
   * own. Two nodes in one process (a test) share one, which is how a revocation
   * published on either is shown to reach the other's sockets (D-85).
   */
  readonly backplane?: Backplane;
  /**
   * The built client this node answers for (D-61). Absent in development, where Vite
   * serves it, and in a deployment that puts the API behind something else.
   */
  readonly client?: Client;
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
  /**
   * The first half of a graceful shutdown (#220): readiness answers 503 from now
   * on, every socket is closed with `RESTARTING` so its client reconnects and
   * replays, and the listener stops accepting while requests already in flight
   * finish. Resolves when they have.
   */
  readonly drain: () => Promise<void>;
  /**
   * What is held for open sockets, per place that holds some. Each must return to
   * zero when its socket closes — a leak here grows with every reconnect — and a
   * test asserts that on the sizes rather than on coverage.
   */
  readonly held: () => HeldByConnections;
}

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
  const { log } = dependencies;
  /** Set once, by `drain`; readiness reads it before anything else. */
  let draining = false;
  // One bucket per user for writes, charged by both doors to `send()`.
  const userWrites = inProcessRateLimiter(
    dependencies.clock,
    dependencies.rateBudgets?.writes ?? WRITE_BUDGET,
  );
  const sockets = createSocketLifecycle({ ...dependencies, userWrites });
  const sending = { ...dependencies, bus: sockets.bus, atomically: sockets.atomically };
  // Uploads being read on this node, against `UPLOADS_AT_ONCE`.
  const uploading = { count: 0 };

  // Server-wide, because that is the one the framework passes on: the per-route
  // option of the same name is silently ignored — measured, a 100 KB frame reached
  // the handler with it set (`docs/spikes/elysia.md`). Over the cap, the server
  // drops the connection before any handler runs. (§5.5)
  const admit = httpLimits({
    database: dependencies.database,
    clock: dependencies.clock,
    writes: userWrites,
    trustProxy: dependencies.config.TRUST_PROXY,
    ...(dependencies.rateBudgets === undefined ? {} : { budgets: dependencies.rateBudgets }),
  });
  const edgeHeaders = responseHeaders(dependencies.config.APP_URL);
  const app = new Elysia({
    websocket: { maxPayloadLength: MAX_FRAME_BYTES },
    // What an upload needs, and no more: every other body is bounded at the edge by its length,
    // before it is read (`bodyRefusal`, D-109 §4).
    serve: { maxRequestBodySize: ATTACHMENT_BYTES_MAX },
  })
    /**
     * One error handler for the whole surface, so a status is decided in exactly
     * one place. `set.status` rather than a thrown response: a second way to
     * choose a status is a second place for two of them to disagree.
     */
    /**
     * Every request is one scope from its first hook: an id the response carries
     * back as `x-request-id`, and which every line written while serving it
     * carries too, however deep (D-71).
     */
    .onRequest(({ request, set }) => {
      // An id from the edge is kept when well-formed, as a label only (#234).
      const requestId = inboundRequestId(request.headers);
      enterRequest({ requestId, startedAt: performance.now() });
      const headers = { ...edgeHeaders, 'x-request-id': requestId };
      Object.assign(set.headers, headers);
      // Before the body is read or a session looked up (D-39 item 2).
      if (isCrossSiteMutation(request, dependencies.config.APP_URL)) {
        return crossSiteResponse(headers);
      }
      if (isUploadRequest(request)) {
        const refusal = uploadRefusal(request, ATTACHMENT_BYTES_MAX);
        if (refusal !== null) return edgeRefusalResponse(refusal, headers);
      } else {
        if (hasUnsupportedMediaType(request)) return unsupportedMediaTypeResponse(headers);
        const tooMuch = bodyRefusal(request, JSON_BODY_MAX_BYTES);
        if (tooMuch !== null) return edgeRefusalResponse(tooMuch, headers);
      }
      return undefined;
    })
    // Before the handler, after the body is parsed: the body is already bounded by the
    // server (`edge.ts`), and a malformed one is a 400 whoever sends it, with no lookup.
    .onBeforeHandle(async ({ request, server, set }) => {
      const wait = await admit(request, peerOf(server, request));
      if (wait === undefined) return;
      set.headers['retry-after'] = String(wait);
      throw new AppError({ code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' });
    })
    .onError(({ code, error, set, path }) => {
      const issues = 'all' in error && Array.isArray(error.all) ? error.all : [];
      const refusal = refusalFor(code, error, issues);
      // The client is told INTERNAL and nothing else; the cause is written here.
      if (refusal.status === 500) log.error('request failed', { err: error, path });
      set.status = refusal.status;
      return refusal.body;
    })
    .onAfterResponse(({ request, path, set }) => {
      const started = currentRequest()?.startedAt;
      // A balancer and the container's own health check poll these every few seconds; at
      // info they were most of the log. A probe that FAILS is not lost: readiness writes the
      // reason at warn.
      const write = path === '/health' || path === '/health/ready' ? log.debug : log.info;
      write('request', {
        method: request.method,
        path,
        status: set.status,
        ...(started === undefined ? {} : { ms: Math.round(performance.now() - started) }),
      });
    })
    .get('/health', () => HEALTH)
    /**
     * Readiness: the database answers, every migration is applied, and the
     * identifier columns compare byte-wise (#108). A word to the caller — health
     * discloses nothing about dependencies — and the reason to the log.
     */
    .get('/health/ready', async ({ set }) => {
      const answer = draining
        ? ({ ready: false, reason: 'draining for shutdown' } as const)
        : await readiness(dependencies.database);
      if (answer.ready) return { status: 'ready' } as const;
      log.warn('not ready', { reason: answer.reason });
      set.status = 503;
      return { status: 'not ready' } as const;
    })

    .get('/auth/github', async ({ set }) => respond(set, await startSignIn(dependencies)))
    .get('/auth/github/callback', async ({ request, set, server }) => {
      // Spent whatever happens next: set before the handler runs, so a refusal
      // carries it too — measured, a header set before a throw survives into
      // the error response (#199).
      set.headers['set-cookie'] = clearedStateCookie();
      const address = clientAddress(
        peerOf(server, request),
        request.headers,
        dependencies.config.TRUST_PROXY,
      );
      return respond(set, await completeSignIn(dependencies, request, address));
    })
    .post('/auth/logout', async ({ request, set }) =>
      respond(set, await signOut({ ...dependencies, bus: sockets.bus }, request)),
    )
    .post('/auth/logout-all', async ({ request, set }) =>
      respond(set, await signOutEverywhere({ ...dependencies, bus: sockets.bus }, request)),
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
    .patch(
      '/api/workspaces/:workspaceId/members/:userId',
      async ({ request, params, body }) =>
        await updateMemberRole(dependencies, request, params.workspaceId, params.userId, body),
    )
    .delete('/api/workspaces/:workspaceId/members/:userId', async ({ request, params, set }) => {
      await removeWorkspaceMember(sending, request, params.workspaceId, params.userId);
      set.status = 204;
      return null;
    })
    .put(
      '/api/workspaces/:workspaceId/deep-work',
      async ({ request, params, body }) =>
        await setMyDeepWork(dependencies, request, params.workspaceId, body),
    )

    .get(
      '/api/workspaces/:workspaceId/channels',
      async ({ request, params }) => await listChannels(dependencies, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/channels', async ({ request, params, body, set }) => {
      set.status = 201;
      return await createWorkspaceChannel(dependencies, request, params.workspaceId, body);
    })
    .post('/api/workspaces/:workspaceId/dms', async ({ request, params, body, set }) => {
      const { channel, created } = await openDirectMessageWith(
        { ...dependencies, bus: sockets.bus },
        request,
        params.workspaceId,
        body,
      );
      // 201 when this call made it, 200 when it was already there: the same pair
      // is the same channel, and a retry is not a second one (I-5).
      set.status = created ? 201 : 200;
      return channel;
    })
    .get(
      '/api/channels/:channelId',
      async ({ request, params }) => await readChannel(dependencies, request, params.channelId),
    )
    .put(
      '/api/channels/:channelId/read',
      async ({ request, params, body }) =>
        await readUpTo({ ...dependencies, bus: sockets.bus }, request, params.channelId, body),
    )
    .put('/api/channels/:channelId/notification-level', async ({ request, params, body, set }) => {
      await setLevel(dependencies, request, params.channelId, body);
      set.status = 204;
      return null;
    })
    .post('/api/channels/:channelId/members', async ({ request, params, body, set }) => {
      await addChannelMember(
        { ...dependencies, bus: sockets.bus },
        request,
        params.channelId,
        body,
      );
      set.status = 204;
      return null;
    })
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
    .delete('/api/messages/:messageId', async ({ request, params, set }) => {
      await removeMessage(sending, request, params.messageId);
      set.status = 204;
      return null;
    })
    .patch(
      '/api/messages/:messageId',
      async ({ request, params, body }) =>
        await editMessage(sending, request, params.messageId, body),
    )
    .get(
      '/api/messages/:messageId/thread',
      async ({ request, params }) => await readThread(dependencies, request, params.messageId),
    )
    .post(
      '/api/messages/:messageId/resolve',
      async ({ request, params }) =>
        await setThreadResolution(sending, request, params.messageId, true),
    )
    .delete(
      '/api/messages/:messageId/resolve',
      async ({ request, params }) =>
        await setThreadResolution(sending, request, params.messageId, false),
    )
    .get(
      '/api/workspaces/:workspaceId/unresolved',
      async ({ request, params }) =>
        await readUnresolved(dependencies, request, params.workspaceId),
    )
    .get('/api/notifications', async ({ request }) => await readInbox(dependencies, request))
    .put('/api/notifications/read', async ({ request, body, set }) => {
      await markNotificationsRead({ ...dependencies, bus: sockets.bus }, request, body);
      set.status = 204;
      return null;
    })
    .post(
      '/api/workspaces/:workspaceId/uploads',
      async ({ request, params, set }) => {
        const { attachment, created } = await receiveUpload(
          { ...sending, storage: dependencies.storage, log: dependencies.log, inFlight: uploading },
          request,
          params.workspaceId,
        );
        set.status = created ? 201 : 200;
        return attachment;
      },
      // The body is the file, read by the handler after the session and the membership (D-109 §3).
      { parse: 'none' },
    )
    .get('/api/attachments/:attachmentId', async ({ request, params, set }) => {
      const { body, headers } = await downloadAttachment(
        dependencies,
        request,
        params.attachmentId,
        'original',
      );
      Object.assign(set.headers, headers);
      return body;
    })
    .get('/api/attachments/:attachmentId/thumbnail', async ({ request, params, set }) => {
      const { body, headers } = await downloadAttachment(
        dependencies,
        request,
        params.attachmentId,
        'thumbnail',
      );
      Object.assign(set.headers, headers);
      return body;
    })
    .delete('/api/attachments/:attachmentId', async ({ request, params, set }) => {
      await discardAttachment(
        { ...sending, storage: dependencies.storage, log: dependencies.log },
        request,
        params.attachmentId,
      );
      set.status = 204;
      return null;
    })
    .get(
      '/api/workspaces/:workspaceId/search',
      async ({ request, params }) => await readSearch(dependencies, request, params.workspaceId),
    )

    .put(
      '/api/messages/:messageId/reactions/:emoji',
      async ({ request, params }) =>
        await changeReaction(sending, request, params.messageId, params.emoji, true),
    )
    .delete(
      '/api/messages/:messageId/reactions/:emoji',
      async ({ request, params }) =>
        await changeReaction(sending, request, params.messageId, params.emoji, false),
    )

    /**
     * The built client, after every route of the API's own: a path the API owns is never
     * answered with HTML, so a mistyped call fails as the API's 404 at the call, not as a
     * parse error somewhere else.
     */
    .get('*', async ({ path, request, set }) => {
      const notFound = new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
      // `clientFileFor` decides whose the path is, read decoded: one place, so `/%61pi` and
      // `/api` cannot be judged twice and differently.
      const file =
        dependencies.client === undefined ? undefined : clientFileFor(dependencies.client, path);
      if (file === undefined) throw notFound;
      set.headers['cache-control'] = file.cacheControl;
      set.headers.etag = file.etag;
      if (file.document) Object.assign(set.headers, DOCUMENT_HEADERS);
      // The browser already has this version: nothing to send (RFC 9110 §13.1.2).
      if (isUnchanged(request.headers.get('if-none-match'), file.etag)) {
        set.status = 304;
        return null;
      }
      // Opened here, so a file gone since it was found is this handler's 404 and not the
      // runtime's own error page, which the one error handler never sees.
      const body = Bun.file(file.path);
      if (!(await body.exists())) throw notFound;
      return body;
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
        const refusal = await sockets.admit(request);
        if (refusal === undefined) return undefined;
        set.status = refusal.status;
        return refusal.body;
      },
      open: async (socket) => {
        await sockets.open(socket);
      },
      message: (socket, raw) => {
        sockets.message(socket, raw);
      },
      close: (socket, code) => {
        sockets.close(socket, code);
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
    held: sockets.held,
    drain: async (): Promise<void> => {
      draining = true;
      sockets.closeAll();
      // Not closing active connections: a request in flight finishes, and so does a
      // frame being handled — the pool closes after this returns, so a handler still
      // reading it would fail on a connection that was pulled out from under it.
      await Promise.all([app.stop(false), sockets.settled()]);
    },
  };
};
