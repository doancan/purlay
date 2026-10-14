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
import { askForExport, downloadExport, readExports } from './exports';
import { goneMessageReference } from '../../platform/gone-message';
import {
  SIGN_IN_REQUEST_BUDGET,
  askForSignInLink,
  consumeSignIn,
  previewSignIn,
} from './email-sign-in';
import type { Outbox } from '../../platform/mail';
import { authMethods } from './auth-methods';
import { Elysia, type HTTPHeaders } from 'elysia';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import type { GitHubClient } from '../../modules/auth/github';
import {
  abandonSignIn,
  completeSignIn,
  signOut,
  eraseMyAccount,
  signOutEverywhere,
  startSignIn,
  type AuthResponse,
} from './auth';
import { SIGN_IN_CALLBACK } from '../../modules/auth/sign-in';
import { clearedStateCookie } from '../../platform/cookies';
import { clientAddress, limitKeyFor, peerOf } from './client-address';
import {
  GITHUB_CALL_BUDGET,
  httpLimits,
  WEBHOOK_BUDGET,
  WEBHOOK_FEED_BUDGET,
  WRITE_BUDGET,
  type HttpBudgets,
} from './rate-limit';
import type { Timers } from '../../realtime/hub';
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
  isWebhookRequest,
  uploadRefusal,
  webhookRefusal,
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
  changeGitHubToken,
  listWorkspaceMembers,
  readGitHubIntegration,
  readAuditTrail,
  removeWorkspaceMember,
  updateMemberRole,
  readMe,
  readWorkspace,
  updateWorkspace,
  readRetentionSetting,
  updateRetentionSetting,
} from './workspaces';
import { readPushKey, setMyLocale, subscribeDevice, unsubscribeDevice } from './push';
import {
  createWorkspaceChannel,
  joinPublicChannel,
  listChannels,
  openConversationWith,
  openDirectMessageWith,
  readChannel,
  readUpTo,
  setLevel,
  addChannelMember,
  archive,
  changeChannel,
  leave,
  listChannelMembers,
} from './channels';
import { markNotificationsRead, readInbox } from './notifications';
import {
  postMessage,
  readFiles,
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
import { credentialCipher } from '../../platform/crypto';
import { githubApi, type GitHubApi } from '../../modules/integrations/unfurl';
import { externalFetch, type ExternalFetch } from '../../modules/images/proxy';
import type { Attention } from '../../platform/attention';
import type { PushSender } from '../../modules/push/sender';
import { serveExternalImage } from './images';
import {
  dropInvitation,
  joinByInvitation,
  lookAtInvitation,
  makeInvitation,
  readInvitations,
} from './invitations';
import { unfurlLink } from './integrations';
import { createSocketLifecycle, type ConnectionLimits, type HeldByConnections } from '../ws/socket';
import { receiveUpload } from './uploads';
import { discardAttachment, downloadAttachment } from './attachments';
import { deleteSaved, listSaved, listSavedIds, putSaved } from './saved';
import { updateMyProfile } from './profile';
import { starChannel } from './star';
import { deleteVersion, listVersions } from './versions';
import { readPresence } from './presence';
import { receiveWebhook } from './webhooks';
import { connectFeed, disconnectFeed, listFeeds } from './feeds';
import { deletePin, listPins, putPin } from './pins';
import {
  listIncidentUpdates,
  patchIncident,
  postIncident,
  putPostmortem,
  putResponder,
  readIncident,
} from './incidents';

export interface Dependencies {
  readonly config: Config;
  /** A `Kysely` or a `Transaction` — indistinguishable here, which is the point (D-46). */
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
  /** Where attachment bytes live (D-109); the unconfigured store refuses every use, loudly. */
  readonly storage: ObjectStore;
  /**
   * Starts making an owner's export once its request has committed (D-140): the process's queue
   * (`exportQueue`). A test about something else makes none.
   */
  readonly exportRunner: (exportId: string) => void;
  /** GitHub's API for unfurling (#66); absent, the real one. A test stands its own server in. */
  readonly githubApi?: GitHubApi;
  /** How an external image is fetched (#110); absent, the checked one. A test stands its own in. */
  readonly externalFetch?: ExternalFetch;
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
  /** Devices told of what needs their person, through both doors; absent where push is off (D-126). */
  readonly push?: PushSender;
  /** Who is in front of a workspace's page now, shared with the push sender it holds back (D-143). */
  readonly attention: Attention;
  /** Presence's grace timers (D-136); a test passes its own, to pass a grace without waiting. */
  readonly timers?: Timers;
  /** Where sign-in links are posted; absent where email sign-in is off (D-138 §6). */
  readonly mail?: Outbox;
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
  /** Resolves when the frames being handled, and the presence being told, are done. */
  readonly settled: () => Promise<void>;
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
  // One bucket per workspace for calls to GitHub, so one member cannot spend the workspace's token.
  const githubCalls = inProcessRateLimiter(dependencies.clock, GITHUB_CALL_BUDGET);
  // The one cipher for stored credentials, its key derived from the root on first use (D-39 §6).
  const cipher = credentialCipher(dependencies.config.ENCRYPTION_KEY);
  const sending = { ...dependencies, bus: sockets.bus, atomically: sockets.atomically };
  // Uploads being read on this node, against `UPLOADS_AT_ONCE`.
  const uploading = { count: 0 };
  // GitHub's deliveries: every address before the signature, each feed after it (D-134 §4).
  const knocks = inProcessRateLimiter(dependencies.clock, WEBHOOK_BUDGET);
  // Sign-in links asked for, per client address (D-138 §7).
  const signInRequests = inProcessRateLimiter(dependencies.clock, SIGN_IN_REQUEST_BUDGET);
  const feedPosts = inProcessRateLimiter(dependencies.clock, WEBHOOK_FEED_BUDGET);
  const delivering = { count: 0 };

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
      } else if (isWebhookRequest(request)) {
        const refusal = webhookRefusal(request);
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
      // A browser GitHub sent back is shown the sign-in screen, never this API's JSON (D-121).
      if (path === SIGN_IN_CALLBACK) {
        return respond(set, abandonSignIn(dependencies, error, refusal.body.error.code));
      }
      // The client is told INTERNAL and nothing else; the cause is written here.
      if (refusal.status === 500) log.error('request failed', { err: error, path });
      // Said by the name of the reference, so a pairing defect is not hidden by the 404 (D-139 §2).
      const gone = goneMessageReference(error);
      if (gone !== undefined)
        log.warn('a write referred to a message that is not there', { constraint: gone, path });
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
    .get('/api/auth/methods', () => authMethods(dependencies.config))
    .post('/auth/email', async ({ request, body, set, server }) => {
      await askForSignInLink(dependencies, body, {
        // Keyed as the edge's budget is: an IPv6 client by its /64 (`limitKeyFor`).
        address: limitKeyFor(
          clientAddress(peerOf(server, request), request.headers, dependencies.config.TRUST_PROXY),
        ),
        requests: signInRequests,
      });
      set.status = 202;
      return null;
    })
    .post('/auth/email/preview', async ({ body }) => await previewSignIn(dependencies, body))
    .post('/auth/email/consume', async ({ request, body, set, server }) =>
      respond(
        set,
        await consumeSignIn(dependencies, body, {
          userAgent: request.headers.get('user-agent') ?? undefined,
          ipAddress: clientAddress(
            peerOf(server, request),
            request.headers,
            dependencies.config.TRUST_PROXY,
          ),
        }),
      ),
    )
    // Spelled out, as every route is, for `scripts/enforcement.test.ts` to read against
    // `API.md`. It is `SIGN_IN_CALLBACK`: were they to differ, the error hook's redirect
    // would miss this route and `auth.integration.test.ts` would see JSON (D-121).
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

    .post('/api/me/erase', async ({ request, body, set }) =>
      respond(set, await eraseMyAccount({ ...dependencies, bus: sockets.bus }, request, body)),
    )
    .get('/api/me', async ({ request }) => await readMe(dependencies, request))
    .patch(
      '/api/me/profile',
      async ({ request, body }) => await updateMyProfile(sending, request, body),
    )
    .put('/api/me/locale', async ({ request, body, set }) => {
      await setMyLocale(dependencies, request, body);
      set.status = 204;
      return null;
    })
    .get('/api/push/key', async ({ request }) => await readPushKey(dependencies, request))
    .post('/api/push/subscriptions', async ({ request, body, set }) => {
      await subscribeDevice(dependencies, request, body);
      set.status = 204;
      return null;
    })
    .post('/api/push/subscriptions/remove', async ({ request, body, set }) => {
      await unsubscribeDevice(dependencies, request, body);
      set.status = 204;
      return null;
    })
    .get('/api/workspaces', async ({ request }) => await listMyWorkspaces(dependencies, request))
    .post('/api/workspaces', async ({ request, body, set }) => {
      set.status = 201;
      return await createMyWorkspace(dependencies, request, body);
    })
    .get(
      '/api/workspaces/:workspaceId',
      async ({ request, params }) => await readWorkspace(dependencies, request, params.workspaceId),
    )
    .patch(
      '/api/workspaces/:workspaceId',
      async ({ request, params, body }) =>
        await updateWorkspace(sending, request, params.workspaceId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/members',
      async ({ request, params }) =>
        await listWorkspaceMembers(dependencies, request, params.workspaceId),
    )
    .post(
      '/api/integrations/github/unfurl',
      async ({ request, body }) =>
        await unfurlLink(
          {
            ...dependencies,
            cipher,
            githubApi: dependencies.githubApi ?? githubApi(),
            githubCalls,
          },
          request,
          body,
        ),
    )
    .get(
      '/api/workspaces/:workspaceId/presence',
      async ({ request, params }) =>
        await readPresence(dependencies, request, params.workspaceId, sockets.online),
    )
    .get(
      '/api/workspaces/:workspaceId/integrations/github',
      async ({ request, params }) =>
        await readGitHubIntegration(dependencies, request, params.workspaceId),
    )
    .put(
      '/api/workspaces/:workspaceId/integrations/github',
      async ({ request, params, body, set }) => {
        await changeGitHubToken({ ...dependencies, cipher }, request, params.workspaceId, body);
        set.status = 204;
        return null;
      },
    )
    .delete(
      '/api/workspaces/:workspaceId/integrations/github',
      async ({ request, params, set }) => {
        await changeGitHubToken(
          { ...dependencies, cipher },
          request,
          params.workspaceId,
          undefined,
        );
        set.status = 204;
        return null;
      },
    )
    .post('/api/workspaces/:workspaceId/invitations', async ({ request, params, set }) => {
      set.status = 201;
      return await makeInvitation(dependencies, request, params.workspaceId);
    })
    .get(
      '/api/workspaces/:workspaceId/invitations',
      async ({ request, params }) =>
        await readInvitations(dependencies, request, params.workspaceId),
    )
    .delete(
      '/api/workspaces/:workspaceId/invitations/:invitationId',
      async ({ request, params, set }) => {
        await dropInvitation(dependencies, request, params.workspaceId, params.invitationId);
        set.status = 204;
        return null;
      },
    )
    .post(
      '/api/invitations/preview',
      async ({ request, body }) => await lookAtInvitation(dependencies, request, body),
    )
    .post(
      '/api/invitations/accept',
      async ({ request, body }) => await joinByInvitation(dependencies, request, body),
    )
    .post('/api/workspaces/:workspaceId/exports', async ({ request, params, set }) => {
      const asked = await askForExport(dependencies, request, params.workspaceId);
      set.status = 202;
      return asked;
    })
    .get(
      '/api/workspaces/:workspaceId/exports',
      async ({ request, params }) => await readExports(dependencies, request, params.workspaceId),
    )
    .get('/api/workspaces/:workspaceId/exports/:exportId/download', async ({ request, params }) => {
      const { body, headers } = await downloadExport(
        dependencies,
        request,
        params.workspaceId,
        params.exportId,
      );
      // A Response of our own: a bare stream Elysia would wrap, and a browser that goes away would
      // cancel the wrapper, never reaching the archive's `cancel` that spends it.
      return new Response(body, { headers });
    })
    .get(
      '/api/workspaces/:workspaceId/retention',
      async ({ request, params }) =>
        await readRetentionSetting(dependencies, request, params.workspaceId),
    )
    .put(
      '/api/workspaces/:workspaceId/retention',
      async ({ request, params, body }) =>
        await updateRetentionSetting(dependencies, request, params.workspaceId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/audit',
      async ({ request, params }) =>
        await readAuditTrail(dependencies, request, params.workspaceId),
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
        await setMyDeepWork(sending, request, params.workspaceId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/saved',
      async ({ request, params }) => await listSaved(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/saved/ids',
      async ({ request, params }) => await listSavedIds(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/channels/:channelId/github-feeds',
      async ({ request, params }) => await listFeeds(dependencies, request, params.channelId),
    )
    .post('/api/channels/:channelId/github-feeds', async ({ request, params, body, set }) => {
      const created = await connectFeed(
        { ...dependencies, cipher },
        request,
        params.channelId,
        body,
      );
      set.status = 201;
      return created;
    })
    .delete('/api/channels/:channelId/github-feeds/:feedId', async ({ request, params, set }) => {
      await disconnectFeed(dependencies, request, params.channelId, params.feedId);
      set.status = 204;
      return null;
    })
    .get(
      '/api/channels/:channelId/incident',
      async ({ request, params }) => await readIncident(dependencies, request, params.channelId),
    )
    .post('/api/channels/:channelId/incident', async ({ request, params, body, set }) => {
      const { incident, changed } = await postIncident(sending, request, params.channelId, body);
      // Made now is 201; the same declaration again is the incident it made, 200 (D-33).
      set.status = changed ? 201 : 200;
      return incident;
    })
    .patch(
      '/api/channels/:channelId/incident/:incidentId',
      async ({ request, params, body }) =>
        await patchIncident(sending, request, params.channelId, params.incidentId, body),
    )
    .put(
      '/api/channels/:channelId/incident/:incidentId/postmortem',
      async ({ request, params, body }) =>
        await putPostmortem(sending, request, params.channelId, params.incidentId, body),
    )
    .put(
      '/api/channels/:channelId/incident/:incidentId/responders/:userId',
      async ({ request, params }) =>
        await putResponder(
          sending,
          request,
          params.channelId,
          params.incidentId,
          params.userId,
          true,
        ),
    )
    .delete(
      '/api/channels/:channelId/incident/:incidentId/responders/:userId',
      async ({ request, params }) =>
        await putResponder(
          sending,
          request,
          params.channelId,
          params.incidentId,
          params.userId,
          false,
        ),
    )
    .get(
      '/api/channels/:channelId/incident/:incidentId/updates',
      async ({ request, params }) =>
        await listIncidentUpdates(dependencies, request, params.channelId, params.incidentId),
    )
    .get(
      '/api/channels/:channelId/pins',
      async ({ request, params }) => await listPins(dependencies, request, params.channelId),
    )
    .get(
      '/api/messages/:messageId/versions',
      async ({ request, params }) => await listVersions(dependencies, request, params.messageId),
    )
    .delete('/api/messages/:messageId/versions/:versionId', async ({ request, params, set }) => {
      await deleteVersion(sending, request, params.messageId, params.versionId);
      set.status = 204;
      return null;
    })
    .put('/api/messages/:messageId/pin', async ({ request, params, set }) => {
      await putPin(sending, request, params.messageId);
      set.status = 204;
      return null;
    })
    .delete('/api/messages/:messageId/pin', async ({ request, params, set }) => {
      await deletePin(sending, request, params.messageId);
      set.status = 204;
      return null;
    })
    .put('/api/messages/:messageId/saved', async ({ request, params, body, set }) => {
      await putSaved(sending, request, params.messageId, body);
      set.status = 204;
      return '';
    })
    .delete('/api/messages/:messageId/saved', async ({ request, params, set }) => {
      await deleteSaved(sending, request, params.messageId);
      set.status = 204;
      return '';
    })

    .get(
      '/api/workspaces/:workspaceId/channels',
      async ({ request, params }) => await listChannels(dependencies, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/channels', async ({ request, params, body, set }) => {
      set.status = 201;
      return await createWorkspaceChannel(
        { ...dependencies, bus: sockets.bus },
        request,
        params.workspaceId,
        body,
      );
    })
    .post('/api/workspaces/:workspaceId/conversations', async ({ request, params, body, set }) => {
      const { channel, created } = await openConversationWith(
        { ...dependencies, bus: sockets.bus },
        request,
        params.workspaceId,
        body,
      );
      // As `/dms`: 201 when this call made it, 200 when these people already had it (I-5).
      set.status = created ? 201 : 200;
      return channel;
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
    .patch(
      '/api/channels/:channelId',
      async ({ request, params, body }) =>
        await changeChannel(sending, request, params.channelId, body),
    )
    .delete('/api/channels/:channelId', async ({ request, params, set }) => {
      await archive(sending, request, params.channelId);
      set.status = 204;
      return null;
    })
    .post('/api/channels/:channelId/leave', async ({ request, params, set }) => {
      await leave(sending, request, params.channelId);
      set.status = 204;
      return null;
    })
    .get(
      '/api/channels/:channelId/members',
      async ({ request, params }) =>
        await listChannelMembers(dependencies, request, params.channelId),
    )
    .put(
      '/api/channels/:channelId/read',
      async ({ request, params, body }) =>
        await readUpTo({ ...dependencies, bus: sockets.bus }, request, params.channelId, body),
    )
    .put('/api/channels/:channelId/star', async ({ request, params, set }) => {
      await starChannel(sending, request, params.channelId, true);
      set.status = 204;
      return null;
    })
    .delete('/api/channels/:channelId/star', async ({ request, params, set }) => {
      await starChannel(sending, request, params.channelId, false);
      set.status = 204;
      return null;
    })
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
        await joinPublicChannel({ ...dependencies, bus: sockets.bus }, request, params.channelId),
    )

    .get(
      '/api/channels/:channelId/messages',
      async ({ request, params }) => await readHistory(dependencies, request, params.channelId),
    )
    .get(
      '/api/channels/:channelId/files',
      async ({ request, params }) => await readFiles(dependencies, request, params.channelId),
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
    .post(
      '/api/webhooks/github/:feedId',
      async ({ request, params, set, server }) => {
        const outcome = await receiveWebhook(
          {
            database: dependencies.database,
            clock: dependencies.clock,
            cipher,
            bus: sockets.bus,
            log: dependencies.log,
            mayDeliver: async (feedId) => await feedPosts.consume(feedId),
            mayKnock: async (address) => await knocks.consume(address),
            inFlight: delivering,
            deadline: async (ms) => {
              await Bun.sleep(ms);
            },
          },
          request,
          params.feedId,
          limitKeyFor(
            clientAddress(
              peerOf(server, request),
              request.headers,
              dependencies.config.TRUST_PROXY,
            ),
          ),
        );
        // What GitHub shows beside the delivery: posted, or why not, all of them received.
        set.status = outcome === 'posted' ? 201 : 200;
        return { outcome };
      },
      // The signature is over the bytes as sent, so the handler reads them, unparsed (D-134 §4).
      { parse: 'none' },
    )
    .get('/api/images', async ({ request, set }) => {
      const { body, headers } = await serveExternalImage(
        { ...dependencies, externalFetch: dependencies.externalFetch ?? externalFetch },
        request,
      );
      Object.assign(set.headers, headers);
      return body;
    })
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
    settled: sockets.settled,
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
