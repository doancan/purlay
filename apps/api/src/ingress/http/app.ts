import { instanceInfo } from '../../modules/administration/admission';
import {
  readAdministrationPreferences,
  writeAdministrationPreferences,
  writeAdministrationAdmission,
  writeAdministrationBatchApproval,
  readOwnAdmission,
  readAdministrationBackups,
  readAdministrationMail,
  readAdministrationUsers,
  readAdministrationUser,
  readAdministrationWorkspaces,
  readAdministrationAudit,
  downloadAdministrationAudit,
  readAdministrationOverview,
  readAdministrationOperations,
  writeAdministrationRole,
  readAdministrationOutbox,
  readAdministrationOutboxFact,
  writeAdministrationModule,
  writeAdministrationModuleSuspension,
  readAdministrationModules,
  writeAdministrationQuota,
  writeAdministrationSessions,
} from './server-administration';
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
import {
  askForExport,
  askForMyExport,
  downloadExport,
  downloadMyExport,
  readExports,
  readMyExports,
} from './exports';
import { goneMessageReference } from '../../platform/gone-message';
import { askForSignInLink, consumeSignIn, previewSignIn } from './magic-link';
import { afterAnswer } from '../../platform/after-answer';
import type { SignInLinkDependencies } from '../../modules/auth/magic-link';
import { authMethods } from './auth-methods';
import { clientInfo, clientPolicyOf } from './client-info';
import { readLatestRelease } from './releases';
import { authorizeNativeClient, exchangeNativeToken } from './native-handoff';
import { clientRefusal, isOutsideClientPolicy } from './client-policy';
import { Elysia, StatusMap, type HTTPHeaders } from 'elysia';
import { leasingExecutor, type Executor, type LeaseConnection } from '@purlay/db';
import type { Auth } from '../../modules/auth/better-auth';
import { sessionAuthOf } from '../../modules/auth/sessions';
import { readWorkspaceCreators } from '../../modules/setup/settings';
import type { ServicesPin, SettingsChange } from '../../modules/setup/runtime';
import type { WorkspaceCreators } from '../../modules/workspaces/creators';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import {
  abandonSignIn,
  readMySignIn,
  answerAuth,
  signOut,
  eraseMyAccount,
  signOutEverywhere,
  startSignIn,
  type AuthResponse,
} from './auth';
import { lift, readServerAccounts, suspend } from './accounts';
import { endMySession, readMySessions } from './devices';
import {
  AUTH_BASE_PATH,
  GITHUB_APP_CALLBACK,
  GOOGLE_CALLBACK,
  OIDC_CALLBACK,
  SIGN_IN_CALLBACK,
  type ModuleId,
} from '@purlay/types';
import { limitKeyFor } from '../../platform/client-key';
import { clientAddress, peerOf, type PeerSource } from './client-address';
import { httpLimits, WRITE_BUDGET, type HttpBudgets } from './rate-limit';
import type { Timers } from '../../realtime/hub';
import { inProcessLimiters } from '../../realtime/rate-limiter';
import type { SharedState } from '../../realtime/shared';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { AppError } from '../../platform/errors';
import type { PeersBehind } from '../../modules/entitlements/peers';
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
  WORKER_HEADERS,
  clientTooOldResponse,
  pathWithoutSecret,
} from './edge';
import { clientFileFor, isUnchanged, type Client } from './client';
import { refusalFor } from './errors';
import {
  createMyWorkspace,
  listMyWorkspaces,
  setMyDeepWork,
  listWorkspaceMembers,
  readAuditTrail,
  exportAuditTrail,
  removeWorkspaceMember,
  leaveWorkspaceMembership,
  requestWorkspaceDeletion,
  cancelWorkspaceDeletion,
  updateMemberRole,
  readMe,
  readWorkspace,
  updateWorkspace,
  readRetentionSetting,
  readStorageUsage,
  updateRetentionSetting,
} from './workspaces';
import { readFind } from './find';
import { readPushKey, setMyLocale, subscribeDevice, unsubscribeDevice } from './push';
import {
  choosePolicyOf,
  claimTheSetup,
  confirmAddress,
  finishTheSetup,
  followAddressLink,
  inviteDone,
  makeAdministrator,
  makeTheFirstWorkspace,
  readSetupState,
  readSetupStatus,
  tryGitHubApp,
  tryMailRelay,
  type SetupAnswer,
  type SetupDependencies,
} from './setup';
import {
  changeSignInPolicy,
  changeWorkspaceCreators,
  connectGitHubApp,
  connectGoogleClient,
  connectOidcProvider,
  connectMailRelay,
  connectIssuesApp,
  disconnectChannel,
  disconnectIssuesApp,
  readServerSettings,
  trySavedServerRelay,
} from './server';
import {
  githubAppApi,
  githubAppCaller,
  platformAppFetch,
  type GitHubAppFetch,
} from '../../platform/github-app-api';
import type { WorkspaceChannels } from '../../modules/workspaces/channels-port';
import type { UserErased } from '../../modules/users/erasure';
import type { WorkspaceCreated } from '../../modules/workspaces/workspaces';
import { latestReleaseCheck } from '../../features/chat/integrations/latest-release';
import type { GitHubAppSettings } from '../../modules/setup/settings';
import {
  CORE_COLLATED_COLUMNS,
  readiness,
  recentReadiness,
  type CollatedColumn,
  type Readiness,
} from '../../platform/readiness';
import {
  moduleSuspendedFamily,
  modulesInfoFamily,
  serverMetrics,
  WEBSOCKET_CONNECTIONS,
  type ServerMetrics,
} from '../../platform/metrics';
import { EXPOSITION_CONTENT_TYPE } from '../../platform/exposition';
import { jobMetrics, readJobRuns } from '../../modules/jobs/metrics';
import { outboxMetrics, readOutbox } from '../../platform/outbox-report';
import { CORE_OWNER, NO_OWNER } from '../../platform/module-kit/ownership';
import { PLAN } from '../../modules/jobs/schedule';
import { EDGE_ROUTE, answerMetrics, methodLabel, routeLabel, statusLabel } from './metrics';
import { currentRequest, enterRequest, noteModule, type Logger } from '../../platform/logging';
import { ATTACHMENT_BYTES_MAX, MAX_FRAME_BYTES } from '@purlay/types';
import type { Backplane } from '../../realtime/bus';
import type { ObjectStore } from '../../platform/storage';
import { credentialCipher } from '../../platform/crypto';
import type { GitHubApi } from '../../features/chat/integrations/unfurl';
import { externalFetch, type ExternalFetch } from '../../modules/images/proxy';
import type { Attention } from '../../platform/attention';
import type { PushSender } from '../../modules/push/sender';
import { serveExternalImage } from './images';
import {
  dropInvitation,
  readInvitationRecipients,
  readInvitationDeliveries,
  resendRecipient,
  dropRecipient,
  joinByInvitation,
  lookAtInvitation,
  makeInvitation,
  openPassport,
  readInvitations,
  type InvitationMailDependencies,
} from './invitations';
import { createSocketLifecycle, type ConnectionLimits, type HeldByConnections } from '../ws/socket';
import { receiveUpload } from './uploads';
import { discardAttachment, downloadAttachment } from './attachments';
import { moduleConnections } from '../../platform/module-budget';
import { deadlinesOf, timedOut, withDeadline } from '../../platform/request-deadline';
import { updateMyProfile } from './profile';
import { readMyQuietHours, setMyQuietHours } from './quiet-hours';
import { setMyAway } from './away';
import { runningModuleIds, type Composition } from '../../composition';
import { notificationSink } from '../../modules/inbox/sink';
import { factRoutingOf } from '../../platform/outbox';
import { factPublisherOf } from '../../platform/ports/fact-publisher';
import { withoutStopped } from '../../platform/suspended-modules';
import { listInbox, readInbox } from './inbox';

export interface Dependencies {
  readonly config: Config;
  /**
   * Better Auth (D-179): every session either door sees is resolved through it, over the same
   * database (`sessions.ts`).
   */
  readonly auth: Auth;
  /**
   * Where `auth` is the holder's (`modules/setup/runtime.ts`): what pins, at a request's first hook, the
   * instance and relay the whole request is served by, so a change of the settings while it is in flight
   * lets it finish on the ones it started on (D-179 §4). Absent where `auth` is an instance nothing swaps.
   */
  readonly services?: ServicesPin;
  /**
   * What the setup's steps change the settings through, and the holder whose pair serves now
   * (`applySettings`, D-179 §4.9): the composition root's. Absent where `auth` is an instance nothing
   * swaps — and there the `/setup` routes that read or change the settings fail as a defect.
   */
  readonly settingsChange?: SettingsChange;
  /** A `Kysely` or a `Transaction` — indistinguishable here, which is the point (D-46). */
  readonly database: Executor;
  /**
   * The shares of the pool the modules hold (`moduleConnections`), where the process has something besides requests that
   * takes them — a module's workers (`modules/workers`) are held to the same slots a request of the module is. Absent, the
   * application makes its own, which is all a process with nothing else needs.
   */
  readonly moduleShares?: LeaseConnection;
  readonly clock: Clock;
  /** Where attachment bytes live (D-109); the unconfigured store refuses every use, loudly. */
  readonly storage: ObjectStore;
  /**
   * Starts making an owner's export once its request has committed (D-140): the process's queue
   * (`exportQueue`). A test about something else makes none.
   */
  readonly exportRunner: (exportId: string) => void;
  /** And a person's export of their own data, in the same queue (D-241). */
  readonly personalExportRunner: (exportId: string) => void;
  /** GitHub's API for unfurling (#66); absent, the real one. A test stands its own server in. */
  readonly githubApi?: GitHubApi;
  /**
   * The GitHub App issues are written through (D-246), as this request reads it; absent, the settings' as the
   * holder serves them (`settingsChange`), and without a holder, none. A test hands its own.
   */
  readonly githubApp?: () => GitHubAppSettings | undefined;
  /** How the App's calls reach GitHub; absent, the platform's `fetch`. A test hands its stand-in's. */
  readonly githubAppFetch?: GitHubAppFetch;
  /** Where Google is, as the sign-in is told; absent, Google's own. A test's stand-in. */
  readonly googleIssuer?: string;
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
   * The state nodes share, with `REDIS_URL` (D-201): limiters, typing and who is online. Absent, all of it
   * is in this process, exactly as a self-hosted instance runs it.
   */
  readonly shared?: SharedState;
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
  /** The socket liveness sweep's own timers and interval (`realtime/liveness.ts`); absent, the real ones. */
  readonly liveness?: { readonly timers?: Timers; readonly intervalMs?: number };
  /**
   * Who may make a workspace (D-155), read per request; absent, the server's setting
   * (`readWorkspaceCreators`, D-179 §6). A test about something else lets anybody.
   */
  readonly workspaceCreators?: (executor: Executor) => Promise<WorkspaceCreators>;
  /**
   * What the modules start a new workspace with, inside its transaction (D-250); absent, what chat starts
   * one with — its first channel (D-174).
   */
  readonly workspaceCreated?: WorkspaceCreated;
  /** The channels of a workspace, as the workspace code asks for them (D-250); absent, chat's. */
  readonly workspaceChannels?: WorkspaceChannels;
  /** What the modules forget of a person whose account is erased, inside the erasure (D-250); absent, chat's. */
  readonly userErased?: UserErased;
  /**
   * The modules this process runs. Required: a caller that forgot it would silently run every module the build carries,
   * and a path of a module left out is a `404`. The process's own (`index.ts`) is `compositionFor(MODULES)`; a test gets the
   * whole build's from `testDependencies`.
   */
  readonly composition: Composition;
  /** How many live nodes of the cluster do not read workspace grants (D-292); absent where there is one node. */
  readonly peersBehind?: PeersBehind;
  /** How many live nodes of the cluster do not read the modules the administrator has stopped (D-296); absent where there is one node. */
  readonly suspensionPeersBehind?: PeersBehind;
  /** What `find` holds a search source to, where a test wants less than `SEARCH_SOURCE_DEADLINE_MS`; a module's own shorter deadline always wins. */
  readonly findDeadlineMs?: number;
  /** The columns the modules declare `COLLATE "C"`, which readiness checks beside the core's (D-250); absent, chat's. */
  readonly collatedColumns?: readonly CollatedColumn[];
  /**
   * The process's one registry (D-221), which the push sender and the mail outbox were handed too;
   * absent, the application keeps one of its own — a test reads it through `/metrics`.
   */
  readonly metrics?: ServerMetrics;
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

/** Paths asked every few seconds by a machine: their request lines are written at debug. */
const POLLED: ReadonlySet<string> = new Set(['/health', '/health/ready', '/metrics']);

/** Liveness. Deliberately touches nothing. */
const HEALTH = { status: 'ok' } as const;

/**
 * The sign-in library's routes (D-179): everything under its base path no route of ours answers. The
 * registrations below spell it as a literal, which `scripts/enforcement.test.ts` reads against
 * `API.md`; the request line's test binds the two spellings (`logging.integration.test.ts`).
 */
const LIBRARY_ROUTE = `${AUTH_BASE_PATH}/*`;

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

/** A setup route's answer, applied: its status, its cookies, its body. */
const answerSetup = <T>(
  set: { status?: number | string; headers: HTTPHeaders },
  answer: SetupAnswer<T>,
): T | string => {
  set.status = answer.status;
  if (answer.setCookie.length > 0) set.headers['set-cookie'] = [...answer.setCookie];
  return answer.status === 204 ? '' : answer.body;
};

/** The setup's paths, its client pages included: nothing under them is for a search engine. */
const SETUP_PATH = /^\/setup(?:\/|$)/;

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
  };
  /**
   * A path of a module this process does not run is no route (`MODULES.md` §3): the `404` of any unknown path, with
   * the generic body and no word that says *disabled*, which would tell a caller who has not signed in which modules
   * this instance runs. Judged on the path as sent, which is the path the router matches (it does not decode `%6d`).
   */
  const closedRoute = (request: Request): boolean => modules.closed(new URL(request.url).pathname);
  const { log } = dependencies;
  const metrics = dependencies.metrics ?? serverMetrics();
  /** How a request reads its workspace's grants (D-289): the composition's set, and the count of a request turned away for one. */
  const entitlements: EntitlementPolicy = {
    effective: modules.effectiveModules,
    refused: (module) => {
      metrics.entitlementRefusals.inc({ module });
    },
  };
  /** The module that owns a route as registered; the request log names it for a module's route only. */
  const moduleOfRoute = (route: string | undefined): string =>
    modules.owner.ofRoute(routeLabel(route));
  const moduleField = (route: string | undefined): { module?: string } => {
    const owner = moduleOfRoute(route);
    return owner === CORE_OWNER || owner === NO_OWNER ? {} : { module: owner };
  };
  /** One request's line on the page: never its path as sent, only the route it was registered as. */
  const observe = (method: string, route: string | undefined, status: number): void => {
    const started = currentRequest()?.startedAt;
    if (started === undefined) return;
    metrics.httpDuration.observe(
      {
        method: methodLabel(method),
        route: routeLabel(route),
        status: statusLabel(status),
        module: moduleOfRoute(route),
      },
      (performance.now() - started) / 1000,
    );
  };
  /** `body` served by one instance of the library, the one current now; see `Dependencies.services`. */
  const within = async <T>(body: () => Promise<T>): Promise<T> =>
    dependencies.services === undefined ? await body() : await dependencies.services.within(body);
  /** Set once, by `drain`; readiness reads it before anything else. */
  let draining = false;
  // One check at a time, reused for a second, however often the outside asks (#636).
  const askReadiness = recentReadiness(
    async () =>
      await readiness(
        dependencies.database,
        [...CORE_COLLATED_COLUMNS, ...dependencies.collatedColumns],
        async () => await dependencies.auth.schemaProblem(),
        () => dependencies.shared?.problem(),
        modules.migrationSets,
      ),
    dependencies.clock,
  );
  // The reason a node is not ready is written once per check, not once per probe that hears it.
  let saidNotReady: Readiness | null = null;
  /** The words an operator writes in `MODULES` for the modules this process runs. */
  const moduleIds = runningModuleIds(modules);
  /** The same, less those the administrator has stopped at run time (D-296): what a client may draw. */
  const runningNow = (): readonly ModuleId[] =>
    moduleIds.filter((id) => !modules.suspension.current().has(id));
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
  // The jobs run in the scheduler's container: their record is read from the database per scrape.
  const readJobs = jobMetrics({
    read: async () => await readJobRuns(dependencies.database),
    known: PLAN.map((slot) => slot.job),
    moduleOf: modules.owner.ofJob,
    log,
  });
  // The modules the build carries that consume a fact, whether this process runs them or not: the rows wait for any node that does.
  const outboxConsumers = modules.bundled
    .filter((module) => (module.manifest.consumes ?? []).length > 0)
    .map((module) => module.manifest.id);
  const readOutboxMetrics = outboxMetrics({
    read: async () =>
      await readOutbox(dependencies.database, outboxConsumers, dependencies.clock.now()),
    log,
  });
  // The one cipher for stored credentials, its key derived from the root on first use (D-39 §6).
  const cipher = credentialCipher(dependencies.config.ENCRYPTION_KEY);
  const sending = { ...dependencies, bus: sockets.bus, atomically: sockets.atomically };
  const inboxDependencies = {
    ...sending,
    running: modules.modules.map((module) => module.manifest.id),
  };
  // Uploads being read on this node, against `UPLOADS_AT_ONCE`.
  const uploading = { count: 0 };
  // Sign-in by link: the library's, decided by Purlay's rules (`modules/auth/magic-link.ts`). Read
  // per request, so building the application asks nothing of the library.
  // What a request for a link comes to is decided after its answer (D-138 §1, §6).
  const afterSignInAnswers = afterAnswer(log, 'sign-in');
  const signInLinks = (): SignInLinkDependencies => ({
    ...dependencies,
    appUrl: dependencies.config.APP_URL,
    links: dependencies.auth.signInLinks,
    later: afterSignInAnswers.run,
  });
  // Invitation letters are posted after the answer too, by the relay the sign-in library mails through.
  const afterInvitationAnswers = afterAnswer(log, 'invitation');
  const invitationMail = (): InvitationMailDependencies => ({
    ...dependencies,
    appUrl: dependencies.config.APP_URL,
    outbox: dependencies.auth.signInLinks?.outbox,
    later: afterInvitationAnswers.run,
  });
  // Who may make a workspace: the setting as it is now, each time it is asked (D-155, D-179 §6).
  const creating = {
    ...dependencies,
    workspaceCreators: dependencies.workspaceCreators ?? readWorkspaceCreators,
    modules: moduleIds,
    suspended: modules.suspension.current,
    effectiveModules: modules.effectiveModules,
  };
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

  // Who consumes what over the whole build, and which of it this process runs: what a publish writes a row for (D-288).
  const factContext = {
    clock: dependencies.clock,
    routing: withoutStopped(
      factRoutingOf(
        modules.bundled.map((module) => module.manifest),
        modules.modules.map((module) => module.manifest),
      ),
      modules.suspension.current,
    ),
    dropped: metrics.outboxDropped,
    refused: metrics.outboxRefused,
    pendingMax: dependencies.config.OUTBOX_PENDING_MAX,
    effective: modules.effectiveModules,
  };
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
            inbox: notificationSink({
              module: module.manifest.id,
              clock: dependencies.clock,
              kinds: modules.noticeOwners,
              bus: sockets.bus,
              log,
              written: metrics.inboxEntries,
              collapsed: metrics.inboxCollapsed,
              pushedKinds: modules.pushedKinds,
              suspended: () => modules.suspension.current().has(module.manifest.id),
              ...(dependencies.push === undefined ? {} : { push: dependencies.push }),
            }),
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
    readiness: async (): Promise<Readiness> =>
      draining ? { ready: false as const, reason: 'draining for shutdown' } : await askReadiness(),
  };
  /** The library's answer to a request under its base path, with the client's address decided here. */
  const library = async (request: Request, server: PeerSource | null): Promise<Response> =>
    await answerAuth(
      dependencies,
      request,
      clientAddress(peerOf(server, request), request.headers, dependencies.config.TRUST_PROXY),
    );
  /**
   * The path a log line names a request by: as sent, except under the library's routes, where it is
   * the route as the library's own table spells it (`Auth.routeOf`) — a reset's token travels in a
   * path segment there, and nothing a caller wrote belongs in the log (D-179 §3) — and an incoming
   * webhook's, whose secret is its last segment (D-245).
   */
  const writtenPath = (route: string | undefined, path: string): string =>
    route === LIBRARY_ROUTE ? dependencies.auth.routeOf(path) : pathWithoutSecret(path);
  /** What a request's own hooks know that the deadline, which wraps them all, needs to answer in their place. */
  const requestIds = new WeakMap<Request, string>();
  const deadlineSignals = new WeakMap<Request, AbortSignal>();
  /** The answer to a module's request that ran past its deadline: the envelope, with the headers the others carry. */
  const answerOverrun = (request: Request, module: string): Response => {
    const { status, body } = refusalFor('UNKNOWN', timedOut(), []);
    const { pathname } = new URL(request.url);
    log.warn('request ran past its deadline', {
      module,
      method: request.method,
      path: pathWithoutSecret(pathname),
    });
    return Response.json(body, {
      status,
      headers: { ...edgeHeaders, 'x-request-id': requestIds.get(request) ?? '' },
    });
  };
  const app = new Elysia({
    websocket: { maxPayloadLength: MAX_FRAME_BYTES },
    // What an upload needs, and no more: every other body is bounded at the edge by its length,
    // before it is read (`bodyRefusal`, D-109 §4).
    serve: { maxRequestBodySize: ATTACHMENT_BYTES_MAX },
  })
    /**
     * A module's request runs against its module's deadline, whatever it waits for (`platform/request-deadline.ts`, D-270).
     * `wrap` is the framework's own hook around the whole of a request, "do not use unless you know exactly what you are
     * doing" in its type's words: `docs/spikes/elysia.md` says what was measured, and `deadline.integration.test.ts` answers
     * a handler that never returns, over `handle` and over a started server, so an upgrade of the framework that changes it
     * fails there.
     */
    .wrap((fn, request) => {
      // The framework types what it wraps as a function that returns a function; it is the request's handler, which answers.
      const handle = fn as unknown as (...given: unknown[]) => Promise<Response> | Response;
      return async (...args: unknown[]): Promise<Response> => {
        const module = modules.owner.ofPath(new URL(request.url).pathname);
        const ms = module === undefined ? undefined : deadlineOf(module);
        if (module === undefined || ms === undefined) return await handle(...args);
        return await withDeadline(
          ms,
          async (signal) => {
            deadlineSignals.set(request, signal);
            return await handle(...args);
          },
          () => answerOverrun(request, module),
        );
      };
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
      enterRequest({ requestId, startedAt: performance.now(), entitlements });
      requestIds.set(request, requestId);
      // Before anything asks the library: every use of it in this request, and in what the request
      // leaves for after its answer, is of the instance current now (D-179 §4).
      dependencies.services?.pin();
      const headers = {
        ...edgeHeaders,
        'x-request-id': requestId,
        ...(SETUP_PATH.test(new URL(request.url).pathname) ? { 'x-robots-tag': 'noindex' } : {}),
      };
      Object.assign(set.headers, headers);
      // A request turned away here never reaches `onAfterResponse`, and it is the one the person who
      // holds its id most needs a line for: written now, as sent except under the library's, whose
      // paths can carry a token and are written as `/auth/*`.
      const turnedAway = (response: Response): Response => {
        const { pathname } = new URL(request.url);
        observe(request.method, EDGE_ROUTE, response.status);
        log.info('request', {
          method: request.method,
          path: pathname.startsWith('/auth/') ? '/auth/*' : pathWithoutSecret(pathname),
          status: response.status,
          ms: Math.round(performance.now() - (currentRequest()?.startedAt ?? performance.now())),
        });
        return response;
      };
      // Before the body is read or a session looked up (D-39 item 2).
      if (isCrossSiteMutation(request, dependencies.config.APP_URL)) {
        return turnedAway(crossSiteResponse(headers));
      }
      // An installed client this server no longer serves is told so, with what to get (D-186): before the
      // body is read or a session looked up, and not for the two things such a client needs in order to
      // learn it — liveness, and `GET /api/client` itself.
      if (!isOutsideClientPolicy(new URL(request.url).pathname)) {
        const tooOld = clientRefusal(
          request.headers.get('x-purlay-client'),
          clientPolicyOf(dependencies.config),
        );
        if (tooOld !== null) return turnedAway(clientTooOldResponse(tooOld, headers));
      }
      if (isUploadRequest(request)) {
        const refusal = uploadRefusal(request, ATTACHMENT_BYTES_MAX);
        if (refusal !== null) return turnedAway(edgeRefusalResponse(refusal, headers));
      } else if (isWebhookRequest(request) && !closedRoute(request)) {
        // A webhook of a module not run is no route: it falls to the body rules of any unknown path below.
        const refusal = webhookRefusal(request);
        if (refusal !== null) return turnedAway(edgeRefusalResponse(refusal, headers));
      } else {
        if (hasUnsupportedMediaType(request))
          return turnedAway(unsupportedMediaTypeResponse(headers));
        const tooMuch = bodyRefusal(request, JSON_BODY_MAX_BYTES);
        if (tooMuch !== null) return turnedAway(edgeRefusalResponse(tooMuch, headers));
      }
      return undefined;
    })
    // Before the handler, after the body is parsed: the body is already bounded by the
    // server (`edge.ts`), and a malformed one is a 400 whoever sends it, with no lookup.
    .onBeforeHandle(async ({ request, server, set, route }) => {
      // The stopped modules are read again when the last read is older than the TTL (D-296): one query in two seconds, not one a request.
      await modules.suspension.fresh();
      if (closedRoute(request)) {
        throw new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
      }
      // From here the request is its module's. The edge's limits and session reads below are the core's: they never touch
      // the leased database.
      const owner = moduleOfRoute(route);
      if (owner !== CORE_OWNER && owner !== NO_OWNER)
        noteModule(owner, deadlineSignals.get(request));
      const wait = await admit(request, peerOf(server, request));
      if (wait === undefined) return;
      set.headers['retry-after'] = String(wait);
      throw new AppError({ code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' });
    })
    .onError(({ code, error, set, path, route }) => {
      const issues = 'all' in error && Array.isArray(error.all) ? error.all : [];
      const refusal = refusalFor(code, error, issues);
      // A browser GitHub sent back is shown the sign-in screen, never this API's JSON (D-121).
      if (path === SIGN_IN_CALLBACK || path === OIDC_CALLBACK || path === GOOGLE_CALLBACK) {
        return respond(set, abandonSignIn(dependencies, error, refusal.body.error.code, path));
      }
      // As a sign-in's: a browser GitHub sent back is sent on to the app, told, never shown JSON (D-246). Not when
      // the module that owns it is not run: that path is no route, and says so like any other.
      if (path === GITHUB_APP_CALLBACK && !modules.closed(path)) {
        if (refusal.status === 500) log.error('request failed', { err: error, path });
        set.status = 302;
        set.headers.location = '/?github=unavailable';
        return '';
      }
      const where = writtenPath(route, path);
      // The client is told INTERNAL and nothing else; the cause is written here.
      if (refusal.status === 500)
        log.error('request failed', { err: error, path: where, ...moduleField(route) });
      // Said by the name of the reference, so a pairing defect is not hidden by the 404 (D-139 §2).
      const gone = goneMessageReference(error);
      if (gone !== undefined) {
        log.warn('a write referred to a message that is not there', {
          constraint: gone,
          path: where,
        });
      }
      if (refusal.body.error.code === 'RATE_LIMITED')
        metrics.rateLimited.inc({ door: 'http', module: moduleOfRoute(route) });
      if (error instanceof AppError && error.retryAfterSeconds !== undefined) {
        set.headers['retry-after'] = String(error.retryAfterSeconds);
      }
      set.status = refusal.status;
      return refusal.body;
    })
    .onAfterResponse(({ request, path, route, set, responseValue }) => {
      const started = currentRequest()?.startedAt;
      // A balancer and the container's own health check poll these every few seconds, and a
      // scraper `/metrics`; at info they were most of the log. A probe that FAILS is not lost:
      // readiness writes the reason at warn.
      const write = POLLED.has(path) ? log.debug : log.info;
      // A handler that returns a `Response` (the library's routes) leaves `set.status` unset.
      const status =
        responseValue instanceof Response
          ? responseValue.status
          : typeof set.status === 'string'
            ? StatusMap[set.status]
            : (set.status ?? 200);
      observe(request.method, route, status);
      write('request', {
        method: request.method,
        path: writtenPath(route, path),
        ...moduleField(route),
        status,
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
        : await askReadiness();
      if (answer.ready) return { status: 'ready' } as const;
      if (answer !== saidNotReady) log.warn('not ready', { reason: answer.reason });
      saidNotReady = answer;
      set.status = 503;
      return { status: 'not ready' } as const;
    })
    // For the operator's scraper alone (D-221): without `METRICS_TOKEN`, or without its token, it is
    // the 404 of a path nothing serves.
    .get('/metrics', async ({ request, set }) => {
      const page = await answerMetrics(
        {
          token: dependencies.config.METRICS_TOKEN,
          metrics,
          read: async () => [
            modulesInfoFamily(moduleIds),
            moduleSuspendedFamily(moduleIds, modules.suspension.current()),
            ...(await readJobs()),
            ...(await readOutboxMetrics()),
          ],
          log,
        },
        request,
      );
      set.headers['content-type'] = EXPOSITION_CONTENT_TYPE;
      set.headers['cache-control'] = 'no-store';
      return page;
    })

    .get('/auth/github', async ({ set }) => respond(set, await startSignIn(dependencies)))
    .get('/auth/oidc', async ({ set }) => respond(set, await startSignIn(dependencies, 'oidc')))
    .get('/auth/google', async ({ set }) => respond(set, await startSignIn(dependencies, 'google')))
    .get('/api/auth/methods', () => authMethods(dependencies.auth))
    .get('/api/client', () => clientInfo(dependencies.config, dependencies.auth, runningNow()))
    // The native application's way in (D-191): the browser's page says yes, the application spends the code.
    .post(
      '/api/native/authorize',
      async ({ request, body }) => await authorizeNativeClient(dependencies, request, body),
    )
    .post('/api/native/token', async ({ request, body, set, server }) =>
      respond(
        set,
        await exchangeNativeToken(dependencies, body, {
          clientHeader: request.headers.get('x-purlay-client'),
          ipAddress: clientAddress(
            peerOf(server, request),
            request.headers,
            dependencies.config.TRUST_PROXY,
          ),
        }),
      ),
    )
    .post('/auth/email', async ({ request, body, set, server }) => {
      await askForSignInLink(
        signInLinks(),
        body,
        // Keyed as the edge's budget is: an IPv6 client by its /64 (`limitKeyFor`).
        limitKeyFor(
          clientAddress(peerOf(server, request), request.headers, dependencies.config.TRUST_PROXY),
        ),
      );
      set.status = 202;
      return null;
    })
    .post('/auth/email/preview', async ({ body }) => await previewSignIn(signInLinks(), body))
    .post('/auth/email/consume', async ({ request, body, set, server }) =>
      respond(
        set,
        await consumeSignIn(signInLinks(), body, {
          userAgent: request.headers.get('user-agent') ?? undefined,
          ipAddress: clientAddress(
            peerOf(server, request),
            request.headers,
            dependencies.config.TRUST_PROXY,
          ),
        }),
      ),
    )
    // The sign-in library's own routes (D-179), which answer only GET and POST: everything under its
    // base path (`AUTH_BASE_PATH`) that no route of ours answers — a static route wins over these
    // whatever the order. Not `.mount`: it strips the prefix the library is configured to expect,
    // and a route registered for every method loses to `GET *` below, the client's (measured on
    // Elysia 1.4.30). The body is left unread for the library, as `.mount` would leave it. Its
    // GitHub callback is `SIGN_IN_CALLBACK`: a failure thrown there reaches the error hook's
    // redirect above, never JSON (D-121).
    .get('/auth/*', async ({ request, server }) => await library(request, server), {
      parse: 'none',
    })
    .post('/auth/*', async ({ request, server }) => await library(request, server), {
      parse: 'none',
    })
    .post('/auth/logout', async ({ request, set }) =>
      respond(set, await signOut({ ...dependencies, bus: sockets.bus }, request)),
    )
    .post('/auth/logout-all', async ({ request, set }) =>
      respond(set, await signOutEverywhere({ ...dependencies, bus: sockets.bus }, request)),
    )

    // The setup in the browser (D-179 §4): not under `/api`, since there is no session yet.
    .get('/setup/status', async () => await readSetupStatus(setup))
    .post('/setup/claim', async ({ body, set }) =>
      answerSetup(set, await claimTheSetup(setup, body)),
    )
    .get('/setup/state', async ({ request, set }) =>
      answerSetup(set, await readSetupState(setup, request)),
    )
    .post('/setup/address', async ({ request, body, set }) =>
      answerSetup(set, await confirmAddress(setup, request, body)),
    )
    .post('/setup/admin', async ({ request, body, set, server }) =>
      answerSetup(
        set,
        await makeAdministrator(
          setup,
          request,
          body,
          clientAddress(peerOf(server, request), request.headers, dependencies.config.TRUST_PROXY),
        ),
      ),
    )
    .post('/setup/policy', async ({ request, body, set }) =>
      answerSetup(set, await choosePolicyOf(setup, request, body)),
    )
    .post('/setup/github', async ({ request, body, set }) =>
      answerSetup(set, await tryGitHubApp(setup, request, body)),
    )
    .post('/setup/smtp', async ({ request, body, set }) =>
      answerSetup(set, await tryMailRelay(setup, request, body)),
    )
    .post('/setup/workspace', async ({ request, body, set }) =>
      answerSetup(set, await makeTheFirstWorkspace(setup, request, body)),
    )
    .post('/setup/invite', async ({ request, set }) =>
      answerSetup(set, await inviteDone(setup, request)),
    )
    .post('/setup/finish', async ({ request, set }) =>
      answerSetup(set, await finishTheSetup(setup, request)),
    )
    .post('/setup/verify', async ({ body }) => await followAddressLink(setup, body))

    .get('/api/instance', async () => await instanceInfo(dependencies.database))
    .get('/api/admission', async ({ request }) => await readOwnAdmission(administration, request))
    .get(
      '/api/server/preferences',
      async ({ request }) => await readAdministrationPreferences(administration, request),
    )
    .post('/api/server/preferences', async ({ request, body, set }) => {
      await writeAdministrationPreferences(administration, request, body);
      set.status = 204;
      return '';
    })
    .post('/api/server/users/:userId/admission', async ({ request, params, body, set }) => {
      await writeAdministrationAdmission(administration, request, params.userId, body);
      set.status = 204;
      return '';
    })
    .get(
      '/api/server/backups',
      async ({ request }) => await readAdministrationBackups(administration, request),
    )
    // Administration → Server (D-179 §4.8): the server's administrator alone; everybody else is absent.
    .get(
      '/api/server/mail-test',
      async ({ request }) => await readAdministrationMail(administration, request),
    )
    .post(
      '/api/server/mail-test',
      async ({ request, body }) => await trySavedServerRelay(setup, request, body),
    )
    .get(
      '/api/server/overview',
      async ({ request }) => await readAdministrationOverview(administration, request),
    )
    .get(
      '/api/server/operations',
      async ({ request }) => await readAdministrationOperations(administration, request),
    )
    .get(
      '/api/server/users',
      async ({ request }) => await readAdministrationUsers(administration, request),
    )
    .get(
      '/api/server/users/:userId',
      async ({ request, params }) =>
        await readAdministrationUser(administration, request, params.userId),
    )
    .get(
      '/api/server/workspaces',
      async ({ request }) => await readAdministrationWorkspaces(administration, request),
    )
    .get(
      '/api/server/outbox',
      async ({ request }) => await readAdministrationOutbox(administration, request),
    )
    .get(
      '/api/server/outbox/:id',
      async ({ request, params }) =>
        await readAdministrationOutboxFact(administration, request, params.id),
    )
    .get(
      '/api/server/audit',
      async ({ request }) => await readAdministrationAudit(administration, request),
    )
    .get(
      '/api/server/audit/export',
      async ({ request }) => await downloadAdministrationAudit(administration, request),
    )
    .post(
      '/api/server/users/approve',
      async ({ request, body }) =>
        await writeAdministrationBatchApproval(administration, request, body),
    )
    .post('/api/server/users/:userId/admin', async ({ request, params, body, set }) => {
      await writeAdministrationRole(administration, request, params.userId, body);
      set.status = 204;
      return '';
    })
    .post('/api/server/users/:userId/revoke-sessions', async ({ request, params, body, set }) => {
      await writeAdministrationSessions(administration, request, params.userId, body);
      set.status = 204;
      return '';
    })
    .post('/api/server/workspaces/:workspaceId/quota', async ({ request, params, body, set }) => {
      await writeAdministrationQuota(administration, request, params.workspaceId, body);
      set.status = 204;
      return '';
    })
    .get(
      '/api/server/modules',
      async ({ request }) => await readAdministrationModules(administration, request),
    )
    .post(
      '/api/server/modules/:moduleId/suspension',
      async ({ request, params, body }) =>
        await writeAdministrationModuleSuspension(administration, request, params.moduleId, body),
    )
    .post('/api/server/workspaces/:workspaceId/modules', async ({ request, params, body, set }) => {
      await writeAdministrationModule(administration, request, params.workspaceId, body);
      set.status = 204;
      return '';
    })
    .get('/api/server/settings', async ({ request }) => await readServerSettings(setup, request))
    .post(
      '/api/server/github',
      async ({ request, body }) => await connectGitHubApp(setup, request, body),
    )
    .post(
      '/api/server/oidc',
      async ({ request, body }) => await connectOidcProvider(setup, request, body),
    )
    .post(
      '/api/server/google',
      async ({ request, body }) => await connectGoogleClient(setup, request, body),
    )
    .post(
      '/api/server/smtp',
      async ({ request, body }) => await connectMailRelay(setup, request, body),
    )
    .delete('/api/server/github', async ({ request, set }) => {
      await disconnectChannel(setup, request, 'github');
      set.status = 204;
      return '';
    })
    .post(
      '/api/server/github-app',
      async ({ request, body }) => await connectIssuesApp(setup, request, body),
    )
    .delete('/api/server/github-app', async ({ request, set }) => {
      await disconnectIssuesApp(setup, request);
      set.status = 204;
      return '';
    })
    .delete('/api/server/oidc', async ({ request, set }) => {
      await disconnectChannel(setup, request, 'oidc');
      set.status = 204;
      return '';
    })
    .delete('/api/server/google', async ({ request, set }) => {
      await disconnectChannel(setup, request, 'google');
      set.status = 204;
      return '';
    })
    .delete('/api/server/smtp', async ({ request, set }) => {
      await disconnectChannel(setup, request, 'smtp');
      set.status = 204;
      return '';
    })
    .post('/api/server/policy', async ({ request, body, set }) => {
      await changeSignInPolicy(setup, request, body);
      set.status = 204;
      return '';
    })
    .post('/api/server/creators', async ({ request, body, set }) => {
      await changeWorkspaceCreators(setup, request, body);
      set.status = 204;
      return '';
    })
    .get(
      '/api/server/accounts',
      async ({ request }) =>
        await readServerAccounts({ ...dependencies, bus: sockets.bus }, request),
    )
    .put('/api/server/accounts/:userId/suspension', async ({ request, params, set }) => {
      await suspend({ ...dependencies, bus: sockets.bus }, request, params.userId);
      set.status = 204;
      return '';
    })
    .delete('/api/server/accounts/:userId/suspension', async ({ request, params, set }) => {
      await lift({ ...dependencies, bus: sockets.bus }, request, params.userId);
      set.status = 204;
      return '';
    })

    .post('/api/me/erase', async ({ request, body, set }) =>
      respond(
        set,
        await eraseMyAccount(
          {
            ...dependencies,
            bus: sockets.bus,
            erasureServices: () => ({
              log,
              cipher,
              githubApp: { app: githubAppSettings(), api: appApi },
            }),
          },
          request,
          body,
        ),
      ),
    )
    .post('/api/me/exports', async ({ request, set }) => {
      const asked = await askForMyExport(dependencies, request);
      set.status = 202;
      return asked;
    })
    .get('/api/me/exports', async ({ request }) => await readMyExports(dependencies, request))
    .get('/api/me/exports/:exportId/download', async ({ request, params }) => {
      const { body, headers } = await downloadMyExport(dependencies, request, params.exportId);
      // Our own Response, as an owner's export's download is: a cancel must reach the archive's.
      return new Response(body, { headers });
    })
    .get('/api/me', async ({ request }) => await readMe(creating, request))
    .get(
      '/api/releases/latest',
      async ({ request }) =>
        await readLatestRelease({ auth: dependencies.auth, releases }, request),
    )
    .get('/api/me/sign-in', async ({ request }) => await readMySignIn(dependencies, request))
    .get(
      '/api/me/sessions',
      async ({ request }) => await readMySessions({ ...dependencies, bus: sockets.bus }, request),
    )
    .delete('/api/me/sessions/:sessionId', async ({ request, params, set }) => {
      await endMySession({ ...dependencies, bus: sockets.bus }, request, params.sessionId);
      set.status = 204;
      return null;
    })
    .patch(
      '/api/me/profile',
      async ({ request, body }) => await updateMyProfile(sending, request, body),
    )
    .get(
      '/api/me/quiet-hours',
      async ({ request }) => await readMyQuietHours(dependencies, request),
    )
    .put(
      '/api/me/quiet-hours',
      async ({ request, body }) => await setMyQuietHours(dependencies, request, body),
    )
    // Away by choice (D-257): stored, then told again through the presence this node keeps.
    .put(
      '/api/me/away',
      async ({ request, body }) => await setMyAway(dependencies, sockets.online, request, body),
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
    .get(
      '/api/workspaces',
      async ({ request }) =>
        await listMyWorkspaces(
          { ...dependencies, effectiveModules: modules.effectiveModules },
          request,
        ),
    )
    .post('/api/workspaces', async ({ request, body, set }) => {
      set.status = 201;
      return await createMyWorkspace(creating, request, body);
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
    .get(
      '/api/workspaces/:workspaceId/invitation-recipients',
      async ({ request, params }) =>
        await readInvitationRecipients(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/invitation-recipients/:recipientId/attempts',
      async ({ request, params }) =>
        await readInvitationDeliveries(
          dependencies,
          request,
          params.workspaceId,
          params.recipientId,
        ),
    )
    .post(
      '/api/workspaces/:workspaceId/invitation-recipients/:recipientId/resend',
      async ({ request, params, set }) => {
        await resendRecipient(invitationMail(), request, params.workspaceId, params.recipientId);
        set.status = 204;
      },
    )
    .delete(
      '/api/workspaces/:workspaceId/invitation-recipients/:recipientId',
      async ({ request, params, set }) => {
        await dropRecipient(dependencies, request, params.workspaceId, params.recipientId);
        set.status = 204;
      },
    )
    .post('/api/workspaces/:workspaceId/invitations', async ({ request, params, body, set }) => {
      set.status = 201;
      return await makeInvitation(invitationMail(), request, params.workspaceId, body);
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
    .post('/api/invitations/passport', async ({ body, set }) => {
      const { setCookie } = await openPassport(dependencies, body);
      if (setCookie.length > 0) set.headers['set-cookie'] = [...setCookie];
      set.status = 204;
      return '';
    })
    .post(
      '/api/invitations/accept',
      async ({ request, body }) =>
        await joinByInvitation(
          { ...dependencies, bus: sockets.bus, effectiveModules: modules.effectiveModules },
          request,
          body,
        ),
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
      '/api/workspaces/:workspaceId/storage',
      async ({ request, params }) =>
        await readStorageUsage(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/find',
      async ({ request, params }) =>
        await readFind(
          {
            ...dependencies,
            sources: modules.findSources,
            off: modules.findSourcesOff,
            deadlineOf,
            ...(dependencies.findDeadlineMs === undefined
              ? {}
              : { sourceDeadlineMs: dependencies.findDeadlineMs }),
          },
          request,
          params.workspaceId,
        ),
    )
    .get(
      '/api/workspaces/:workspaceId/audit',
      async ({ request, params }) =>
        await readAuditTrail(dependencies, request, params.workspaceId),
    )
    .get('/api/workspaces/:workspaceId/audit/export', async ({ request, params }) => {
      const { body, headers } = await exportAuditTrail(dependencies, request, params.workspaceId);
      // A Response of our own, as an export's download is: a bare stream Elysia would wrap, and a
      // browser that goes away would cancel the wrapper, not the pages being read.
      return new Response(body, { headers });
    })
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
    .delete('/api/workspaces/:workspaceId/membership', async ({ request, params, set }) => {
      await leaveWorkspaceMembership(sending, request, params.workspaceId);
      set.status = 204;
      return null;
    })
    .post(
      '/api/workspaces/:workspaceId/deletion',
      async ({ request, params, body }) =>
        await requestWorkspaceDeletion(sending, request, params.workspaceId, body),
    )
    .delete('/api/workspaces/:workspaceId/deletion', async ({ request, params, set }) => {
      await cancelWorkspaceDeletion(sending, request, params.workspaceId);
      set.status = 204;
      return null;
    })
    .put(
      '/api/workspaces/:workspaceId/deep-work',
      async ({ request, params, body }) =>
        await setMyDeepWork(sending, request, params.workspaceId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/inbox',
      async ({ request, params }) =>
        await listInbox(inboxDependencies, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/inbox/read', async ({ request, params, body, set }) => {
      await readInbox(inboxDependencies, request, params.workspaceId, body);
      set.status = 204;
      return null;
    })
    .use(moduleRoutes)

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
    .get('/api/images', async ({ request, set }) => {
      const { body, headers } = await serveExternalImage(
        { ...dependencies, externalFetch: dependencies.externalFetch ?? externalFetch },
        request,
      );
      Object.assign(set.headers, headers);
      return body;
    })
    .get('/api/attachments/:attachmentId', async ({ request, params, set }) => {
      const download = await downloadAttachment(
        dependencies,
        request,
        params.attachmentId,
        'original',
      );
      Object.assign(set.headers, download.headers);
      set.status = download.status;
      return download.status === 304 ? null : download.body;
    })
    .get('/api/attachments/:attachmentId/thumbnail', async ({ request, params, set }) => {
      const download = await downloadAttachment(
        dependencies,
        request,
        params.attachmentId,
        'thumbnail',
      );
      Object.assign(set.headers, download.headers);
      set.status = download.status;
      return download.status === 304 ? null : download.body;
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
      if (file.worker) Object.assign(set.headers, WORKER_HEADERS);
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
      ]);
    },
    drain: async (): Promise<void> => {
      draining = true;
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
