import { pushConfiguration } from '../../modules/push/settings';
import { CORE_JOBS } from '../../platform/module-kit/core-claims';
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
import { afterAnswer } from '../../platform/after-answer';
import { Elysia, type AnyElysia } from 'elysia';
import { leasingExecutor } from '@purlay/db';
import { sessionAuthOf } from '../../modules/auth/sessions';
import { httpLimits, WRITE_BUDGET } from './rate-limit';
import { inProcessLimiters } from '../../realtime/rate-limiter';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { responseHeaders } from './edge';
import { type SetupDependencies } from './setup';
import { githubAppApi, githubAppCaller, platformAppFetch } from '../../platform/github-app-api';
import { latestReleaseCheck } from '../../features/chat/integrations/latest-release';
import type { GitHubAppSettings } from '../../modules/setup/settings';
import { serverMetrics, WEBSOCKET_CONNECTIONS } from '../../platform/metrics';
import { CORE_OWNER, NO_OWNER } from '../../platform/module-kit/ownership';
import { ATTACHMENT_BYTES_MAX, MAX_FRAME_BYTES } from '@purlay/types';
import { credentialCipher } from '../../platform/crypto';
import type { GitHubApi } from '../../features/chat/integrations/unfurl';
import { createSocketLifecycle, type HeldByConnections } from '../ws/socket';
import { moduleConnections } from '../../platform/module-budget';
import { deadlinesOf } from '../../platform/request-deadline';
import { runningModuleIds } from '../../composition';
import { factContextOf, sinkOfModule } from '../../module-seams-wiring';
import { factPublisherOf } from '../../platform/ports/fact-publisher';
import type { HandlerDependencies, LeasedDependencies } from './dependencies';
import { requestObservation } from './request-observation';
import { requestHooks } from './request-hooks';
import type { RouteContext } from './route-context';
import { probeRoutes } from './routes/probe-routes';
import { signInRoutes } from './routes/sign-in-routes';
import { setupRoutes } from './routes/setup-routes';
import { serverRoutes } from './routes/server-routes';
import { meRoutes } from './routes/me-routes';
import { workspaceRoutes } from './routes/workspace-routes';
import { companyIdentityRoutes } from './routes/company-identity-routes';
import { workspaceSecurityRoutes } from './routes/workspace-security-routes';
import { workspaceProvisioningRoutes } from './routes/workspace-provisioning-routes';
import { workspaceDirectoryRoutes } from './routes/workspace-directory-routes';
import { attachmentRoutes } from './routes/attachment-routes';
import { clientRoutes } from './routes/client-routes';
import { errorHook } from './error-hook';

export interface Dependencies extends HandlerDependencies {
  /** GitHub's API for unfurling (#66); absent, the real one. A test stands its own server in. */
  readonly githubApi?: GitHubApi;
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
  /**
   * Resolves when the frames being handled, the presence being told, and the sign-in links being made
   * after their answers are done.
   */
  readonly settled: () => Promise<void>;
}

export const createApp = (given: Dependencies): HttpApplication => {
  // The modules this process runs (`composition.ts`).
  const modules = given.composition;
  const dependencies = {
    ...given,
    // The one database a handler can reach, leased by the module the request belongs to: the module's share of the
    // pool holds each of its statements, with nothing for a handler to ask for (`platform/module-budget.ts`, D-266).
    database: leasingExecutor(
      given.database,
      given.moduleShares ??
        moduleConnections(
          modules.bundled.map((module) => module.manifest),
          given.config.DATABASE_POOL_MAX,
        ),
    ),
    readAttachment: modules.readAttachment,
    workspaceCreated: given.workspaceCreated ?? modules.workspaceCreated,
    workspaceChannels: given.workspaceChannels ?? modules.workspaceChannels,
    auditAccess: modules.auditAccess,
    userErased: given.userErased ?? modules.userErased,
    collatedColumns: given.collatedColumns ?? modules.collatedColumns,
  } satisfies LeasedDependencies;
  const { log } = dependencies;
  const metrics = dependencies.metrics ?? serverMetrics();
  /** How a request reads its workspace's grants (D-289): the composition's set, and the count of a request turned away for one. */
  const entitlements: EntitlementPolicy = {
    effective: modules.effectiveModules,
    refused: (module) => {
      metrics.entitlementRefusals.inc({ module });
    },
  };
  const observation = requestObservation({ modules, metrics, auth: dependencies.auth });
  /** `body` served by one instance of the library, the one current now; see `Dependencies.services`. */
  const within = async <T>(body: () => Promise<T>): Promise<T> =>
    dependencies.services === undefined ? await body() : await dependencies.services.within(body);
  /** The words an operator writes in `MODULES` for the modules this process runs. */
  const moduleIds = runningModuleIds(modules);
  // One bucket per user for writes, charged by both doors to `send()`.
  const limiterFor = dependencies.shared?.limiters ?? inProcessLimiters(dependencies.clock);
  const userWrites = limiterFor('writes', dependencies.rateBudgets?.writes ?? WRITE_BUDGET);
  const deadlineOf = deadlinesOf(modules.bundled.map((module) => module.manifest));
  const sockets = createSocketLifecycle({
    ...dependencies,
    deadlineOf,
    userWrites,
    metrics,
    closedFrame: modules.closedFrame,
    frameHandlers: modules.frameHandlers,
    frameOwner: modules.owner.ofFrame,
    moduleOfFrame: (op) => {
      const owner = modules.owner.ofFrame(op);
      return owner === CORE_OWNER || owner === NO_OWNER ? undefined : owner;
    },
    closedEvent: modules.closedEvent,
  });
  metrics.registry.gauge(
    WEBSOCKET_CONNECTIONS.name,
    WEBSOCKET_CONNECTIONS.help,
    () => sockets.held().connections,
  );
  // The modules the build carries that consume a fact, whether this process runs them or not: the rows wait for any node that does.
  const outboxConsumers = modules.bundled
    .filter((module) => (module.manifest.consumes ?? []).length > 0)
    .map((module) => module.manifest.id);
  // The inbox lists the notices of the modules this process runs and no others (D-286). Made here, beside the
  // composition it is read from, since the guard on it (`scripts/mutations/api-ingress-http.ts`) names this line.
  const inbox = {
    running: modules.modules.map((module) => module.manifest.id),
  };
  const context: RouteContext = { dependencies, modules, moduleIds, deadlineOf, sockets, inbox };
  const probes = probeRoutes(context, { metrics, outboxConsumers });
  // The one cipher for stored credentials, its key derived from the root on first use (D-39 §6).
  const cipher = credentialCipher(dependencies.config.ENCRYPTION_KEY);
  const browserPush = pushConfiguration(
    dependencies.database,
    cipher,
    dependencies.clock,
    dependencies.config,
  );
  // What a request for a link comes to is decided after its answer (D-138 §1, §6).
  const afterSignInAnswers = afterAnswer(log, 'sign-in');
  // Invitation letters are posted after the answer too, by the relay the sign-in library mails through.
  const afterInvitationAnswers = afterAnswer(log, 'invitation');
  const afterWorkspaceActivity = afterAnswer(log, 'workspace activity');
  // The GitHub App (D-246): its settings as this request pinned them, and GitHub as the App speaks to it.
  const githubUrls = {
    web: dependencies.config.GITHUB_URL,
    api: dependencies.config.GITHUB_API_URL,
  };
  const appApi = githubAppApi(
    githubAppCaller(dependencies.githubAppFetch ?? platformAppFetch, () =>
      dependencies.clock.now(),
    ),
    githubUrls,
  );
  // One per application: what it has asked GitHub is kept for every caller (D-248).
  const releases = latestReleaseCheck({
    enabled: dependencies.config.UPDATE_CHECK,
    apiUrl: dependencies.config.GITHUB_API_URL,
    fetch: dependencies.githubAppFetch ?? platformAppFetch,
    clock: dependencies.clock,
    log,
  });
  // The GitHub App's settings as this request reads them: the holder's, or a test's (D-246).
  const githubAppSettings = (): GitHubAppSettings | undefined =>
    dependencies.githubApp === undefined
      ? dependencies.settingsChange?.holder.current()?.settings.githubApp
      : dependencies.githubApp();

  const seamInputs = {
    composition: modules,
    clock: dependencies.clock,
    bus: sockets.bus,
    log,
    metrics,
    outboxPendingMax: dependencies.config.OUTBOX_PENDING_MAX,
    ...(dependencies.push === undefined ? {} : { push: dependencies.push }),
  };
  const factContext = factContextOf(seamInputs);
  // Each bundled module's own routes (D-280), made from what they are handed: a module that is not run is closed by its
  // manifest, as the rest of the surface is (D-255 §2).
  const moduleRoutes = modules.bundled.flatMap((module) =>
    module.routes === undefined
      ? []
      : [
          module.routes({
            auth: sessionAuthOf(dependencies.auth),
            database: dependencies.database,
            clock: dependencies.clock,
            log,
            config: {
              APP_URL: dependencies.config.APP_URL,
              GITHUB_API_URL: dependencies.config.GITHUB_API_URL,
              TRUST_PROXY: dependencies.config.TRUST_PROXY,
            },
            ...(dependencies.githubApi === undefined ? {} : { githubApi: dependencies.githubApi }),
            ...(dependencies.push === undefined ? {} : { push: dependencies.push }),
            permissions: modules.permissions,
            inbox: sinkOfModule(module.manifest.id, seamInputs),
            publishFact: factPublisherOf(module.manifest.id, factContext),
            ports: modules.portsFor(module.manifest.id, dependencies.database),
            bus: sockets.bus,
            atomically: sockets.atomically,
            online: sockets.online,
            cipher,
            limiterFor,
            githubAppSettings,
            githubAppApi: appApi,
            githubUrls,
          }),
        ],
  );
  // Server-wide, because that is the one the framework passes on: the per-route
  // option of the same name is silently ignored — measured, a 100 KB frame reached
  // the handler with it set (`docs/spikes/elysia.md`). Over the cap, the server
  // drops the connection before any handler runs. (§5.5)
  const admit = httpLimits({
    auth: dependencies.auth,
    clock: dependencies.clock,
    writes: userWrites,
    limiters: limiterFor,
    trustProxy: dependencies.config.TRUST_PROXY,
    ...(dependencies.rateBudgets === undefined ? {} : { budgets: dependencies.rateBudgets }),
  });
  const edgeHeaders = responseHeaders(dependencies.config.APP_URL);
  const setup: SetupDependencies = {
    ...dependencies,
    settingsChange: dependencies.settingsChange,
  };
  const administration = {
    ...dependencies,
    pushConfiguration: browserPush,
    bus: sockets.bus,
    modules: moduleIds,
    entitlements: {
      carried: modules.bundled.map((module) => module.manifest),
      mode: modules.entitlementMode,
    },
    peersBehind: dependencies.peersBehind,
    suspensionPeersBehind: dependencies.suspensionPeersBehind,
    suspension: modules.suspension,
    outboxConsumers,
    jobs: [
      ...CORE_JOBS,
      ...Object.keys(modules.jobWork).filter((name) => !modules.closedJob(name)),
    ],
    readiness: probes.readiness,
  };
  /**
   * The routes, in the order they are registered. The built client is last of the API's own: a path the API owns is
   * never answered with HTML, so a mistyped call fails as the API's 404 at the call, not as a parse error somewhere
   * else. A list typed as plugins, as the modules' are, and not one `.use` for each: a plugin whose type is `AnyElysia`
   * used by itself would type the rest of the chain, the socket's route included, as `any`.
   */
  const routes: AnyElysia[] = [
    probes.routes,
    signInRoutes(context, afterSignInAnswers.run),
    setupRoutes(context, setup),
    serverRoutes(context, setup, administration),
    meRoutes(context, {
      browserPush,
      releases,
      // What an account's erasure also takes with it: the GitHub App's installation and the credentials sealed for it.
      erasureServices: () => ({
        log,
        cipher,
        githubApp: { app: githubAppSettings(), api: appApi },
      }),
    }),
    workspaceRoutes(context, afterInvitationAnswers.run),
    companyIdentityRoutes(context, cipher),
    workspaceSecurityRoutes(context, cipher),
    workspaceProvisioningRoutes(context),
    workspaceDirectoryRoutes(context),
    ...moduleRoutes,
    attachmentRoutes(context),
    clientRoutes(context),
  ];
  const hooks = requestHooks({
    dependencies,
    modules,
    log,
    entitlements,
    edgeHeaders,
    deadlineOf,
    admit,
    observation,
    activityLater: afterWorkspaceActivity.run,
  });
  const onError = errorHook({ dependencies, modules, log, metrics, observation });
  const app = new Elysia({
    websocket: { maxPayloadLength: MAX_FRAME_BYTES },
    // What an upload needs, and no more: every other body is bounded at the edge by its length,
    // before it is read (`bodyRefusal`, D-109 §4).
    serve: { maxRequestBodySize: ATTACHMENT_BYTES_MAX },
  })
    .wrap(hooks.wrap)
    .onRequest(hooks.onRequest)
    .onBeforeHandle(hooks.onBeforeHandle)
    .onError(onError)
    .onAfterResponse(hooks.onAfterResponse)
    .mapResponse(hooks.onMapResponse)
    .use(routes)

    /**
     * The socket.
     *
     * `beforeHandle` runs **before the socket is bound** — verified, not assumed
     * (`docs/spikes/elysia.md`) — so a wrong origin and a missing session are
     * refused with a real HTTP status rather than a socket that opens and then
     * closes for a reason the client has to guess at (D-39, §7.2).
     *
     * Admission is a guard around the route, not an option of it: the framework runs a socket
     * route's own `beforeHandle` in the route and then once more inside the upgrade handler it
     * builds, and ignores the second answer — a second read of the session, and a second look at
     * the cap, for every admitted socket, whose result nobody reads. A guard's hook runs once.
     */
    .guard(
      {
        // An upgrade's admission and a socket's open are flows of their own: each served by one instance.
        beforeHandle: async ({ request, set }) => {
          const refusal = await within(async () => await sockets.admit(request));
          if (refusal === undefined) return undefined;
          set.status = refusal.status;
          return refusal.body;
        },
      },
      (guarded) =>
        guarded.ws('/ws', {
          open: async (socket) => {
            await within(async () => {
              await sockets.open(socket);
            });
          },
          message: (socket, raw) => {
            sockets.message(socket, raw);
          },
          close: (socket, code) => {
            sockets.close(socket, code);
          },
        }),
    );

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
    settled: async (): Promise<void> => {
      await Promise.all([
        sockets.settled(),
        afterSignInAnswers.settled(),
        afterInvitationAnswers.settled(),
        afterWorkspaceActivity.settled(),
      ]);
    },
    drain: async (): Promise<void> => {
      probes.startDraining();
      sockets.closeAll();
      // Not closing active connections: a request in flight finishes, and so does a
      // frame being handled — the pool closes after this returns, so a handler still
      // reading it would fail on a connection that was pulled out from under it. The
      // same for a sign-in link being made after its answer.
      await Promise.all([app.stop(false), sockets.settled()]);
      await Promise.all([afterSignInAnswers.settled(), afterInvitationAnswers.settled()]);
    },
  };
};
