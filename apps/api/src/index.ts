/**
 * `apps/api` — Bun + ElysiaJS, one process.
 *
 * The composition root, and the only file that reads the environment or opens a
 * connection. Everything below takes what it needs as an argument, which is what
 * makes it testable without a process (D-46).
 *
 * Layering is `ingress → modules → platform`, enforced by lint rather than by
 * convention (`ARCHITECTURE.md` §4).
 */
import { exportQueue } from './modules/export/queue';
import { compositionFor, moduleReport, workersOf, type Composition } from './composition';
import { ModuleConfigError } from './platform/module-kit/registry';
import { checkRelay } from './platform/mail';
import { createDatabase, leasingExecutor } from '@purlay/db';
import { databaseConnection } from './platform/database';
import { loadConfig } from './platform/config';
import { systemClock } from './platform/clock';
import { deriveAuthSecret } from './modules/auth/better-auth';
import {
  envSeedOf,
  ignoredEnvironment,
  importFromEnvOnce,
  readSettingsToBoot,
} from './modules/setup/settings';
import { issueSetupCode } from './modules/setup/setup';
import {
  runtimeServicesFrom,
  runtimeServicesHolder,
  type RuntimeBase,
  type RuntimeServices,
} from './modules/setup/runtime';
import type { SealedSetting, ServerSettings } from './modules/setup/settings';
import { credentialCipher } from './platform/crypto';
import { inProcessBackplane } from './realtime/bus';
import { bunRedisClient, connectRedis } from './platform/redis';
import { advertiseEntitlements, peersBehind } from './realtime/entitlement-peers';
import { moduleSetOf, watchModuleSet } from './realtime/module-set';
import { inProcessRateLimiter } from './realtime/rate-limiter';
import { sharedRealtime } from './realtime/shared';
import { createApp } from './ingress/http/app';
import { createLogger } from './platform/logging';
import { sendAuditLinesTo } from './modules/audit/lines';
import { errorTrackingFor, reportUrgently } from './platform/error-tracking';
import {
  closeAfterDrain,
  drainRefusingChanges,
  installCrashHandlers,
  installShutdown,
} from './lifecycle';
import { migrateOnStart, untilMigrated } from './platform/migrate-on-start';
import { openClient } from './ingress/http/client';
import { storeFor } from './platform/storage';
import { inMemoryAttention } from './platform/attention';
import { NOTICE_PUSH_BUDGET, PUSH_TIMEOUT_MS, createPushSender } from './modules/push/sender';
import { checkingLookup, postExternal, systemResolver } from './modules/images/fetch-external';
import { serverMetrics } from './platform/metrics';
import { moduleConnections } from './platform/module-budget';
import { startWorkers, type Workers } from './modules/workers/module-workers';
import { readSuspended, suspensionCache } from './platform/suspended-modules';

const config = loadConfig(process.env);
const plainLog = createLogger({ level: config.LOG_LEVEL });

// Off unless ERROR_TRACKING_DSN is set (D-96). A DSN that cannot be parsed refuses
// to start, here, rather than failing quietly at the first error. Everything logged
// at `error` below is also reported, cleaned the way the log is.
const { tracker: errorTracker, log } = errorTrackingFor(config, plainLog, systemClock);
// Every entry this process writes to the trail is also a line of its log, ids only (D-222).
sendAuditLinesTo(log);
// The modules the administrator has stopped at run time, read from the database through a cache of two seconds (D-296). The
// pool it reads through is opened below; nothing asks before then.
const suspension = suspensionCache({ read: async () => await readSuspended(database), log });
// The modules this process runs, named by `MODULES` (D-250): a setting that names none the build carries stops
// the start here, before anything listens.
const modules = ((): Composition => {
  try {
    return compositionFor(config.MODULES, config.WORKSPACE_MODULES, suspension);
  } catch (error) {
    if (!(error instanceof ModuleConfigError)) throw error;
    log.error('MODULES cannot be run; exiting', { problems: error.problems });
    process.exit(1);
  }
})();
log.info('the modules this process runs', moduleReport(modules));
// From here on an error nothing handled is reported and ends the process, never left half-alive
// (#634). The line goes to the plain log and the report straight to the tracker, as urgent, so a
// tracker full of ordinary reports cannot be the reason it is not sent.
const crash = installCrashHandlers({
  log: plainLog,
  report: reportUrgently(errorTracker),
  flush: errorTracker.flush,
  process,
  deadlineMs: 2_000,
});

// Opened before anything listens: a build without its shell refuses to start (D-61).
const client = config.CLIENT_DIST === undefined ? undefined : openClient(config.CLIENT_DIST);
log.info(
  client === undefined ? 'no client is served: CLIENT_DIST is unset' : 'serving the client',
  client === undefined ? {} : { dist: client.dist },
);

// How to reach the database, for the application's pool and for the connection a
// migration on start opens for itself (D-87): the same place, the same TLS.
const connection = databaseConnection(config, log);

const database = createDatabase({ ...connection, poolSize: config.DATABASE_POOL_MAX });
// The modules' shares of that pool, one set for what serves requests and what runs on a timer: a module's workers and its
// requests take from the same slots (`MODULES.md` §7).
const moduleShares = moduleConnections(
  modules.bundled.map((module) => module.manifest),
  config.DATABASE_POOL_MAX,
);

// What this process counts for `/metrics` (D-221): one registry, handed to everything that records.
// Kept whether or not METRICS_TOKEN is set — counting is cheap; without it the page is never served.
const metrics = serverMetrics(
  undefined,
  modules.bundled.map((module) => module.manifest.id),
  modules.bundled.flatMap((module) =>
    workersOf(module).map((worker) => ({ module: module.manifest.id, name: worker.name })),
  ),
  modules.bundled.flatMap((module) =>
    (module.manifest.notifications ?? []).map((kind) => ({
      module: module.manifest.id,
      kind: kind.type,
    })),
  ),
  modules.bundled.flatMap((module) =>
    (module.manifest.consumes ?? []).map((fact) => ({ module: module.manifest.id, fact })),
  ),
);
log.info(
  config.METRICS_TOKEN === undefined
    ? 'metrics are off: METRICS_TOKEN is unset'
    : 'metrics are served at /metrics',
);

// Who is in front of a workspace's page now: heard by the sockets, asked by the push sender (D-143).
const attention = inMemoryAttention(systemClock);

// Web Push (#78, D-126): on with the three keys, which the configuration has checked are one pair.
const push =
  config.VAPID_PUBLIC_KEY === undefined ||
  config.VAPID_PRIVATE_KEY === undefined ||
  config.VAPID_SUBJECT === undefined
    ? undefined
    : await createPushSender({
        database,
        clock: systemClock,
        log,
        attention,
        notices: modules.pushNotices,
        noticeWords: modules.noticeWords,
        noticeThrottle: inProcessRateLimiter(systemClock, NOTICE_PUSH_BUDGET),
        failures: metrics.pushFailures,
        owner: modules.pushOwner,
        // The checked address lookup an external image uses, and the push's own timeout (D-126 §6).
        post: async (url, headers, body) =>
          await postExternal(url, headers, body, {
            lookup: checkingLookup(systemResolver),
            timeoutMs: PUSH_TIMEOUT_MS,
          }),
        keys: {
          publicKey: config.VAPID_PUBLIC_KEY,
          privateKey: config.VAPID_PRIVATE_KEY,
          subject: config.VAPID_SUBJECT,
        },
      });
log.info(push === undefined ? 'web push is off: no VAPID keys' : 'web push is on');

// An owner's exports, one at a time, made by this process after answering (D-140).
const storage = storeFor(config);
const exports = exportQueue({
  database,
  clock: systemClock,
  log,
  storage,
  catalogue: modules.exportCatalogue,
  personalCatalogue: modules.personalExportCatalogue,
});

// The transport this node's sockets hear on. Made here, rather than by the application, so that
// the sign-in library publishes on it too: a session it ends closes the sockets it held (D-85).
//
// With `REDIS_URL` the nodes of a cloud share one (D-201); without it nothing here opens a connection
// and the node keeps its own, as a self-hosted instance always has (D-7).
const redisUrl = config.REDIS_URL;
const redis =
  redisUrl === undefined
    ? undefined
    : connectRedis({
        create: () => bunRedisClient(redisUrl),
        log,
        namespace: config.REDIS_KEY_PREFIX,
      });
const sharing = redis === undefined ? undefined : sharedRealtime(redis, systemClock, log);
log.info(
  redis === undefined
    ? "realtime state is this node's own: no REDIS_URL"
    : 'realtime state is shared through Redis',
);
const backplane = sharing?.backplane ?? inProcessBackplane();
// Where nodes share state they also share the question of which modules each runs: a mismatch is said, never
// acted on, so a rolling deploy of a new set passes (D-250).
const nodeId = crypto.randomUUID();
const moduleSetWatch =
  redis === undefined
    ? undefined
    : watchModuleSet({
        link: redis,
        nodeId,
        set: moduleSetOf(modules.modules.map((module) => module.manifest.id)),
        mode: modules.entitlementMode,
        log,
      });
// And of which of them read a workspace's grants, so that a restriction is not written beside one that does not (D-292).
const grantsAdvertised =
  redis === undefined ? undefined : advertiseEntitlements({ link: redis, nodeId, log });
const moduleSet = {
  stop: async (): Promise<void> => {
    await grantsAdvertised?.stop();
    await moduleSetWatch?.stop();
  },
};

// Who every request and socket is: sessions are resolved through Better Auth, signing with a secret
// derived from ENCRYPTION_KEY and never stored, and its routes answer under /auth (D-179). What it
// takes that is not a setting is the process's own, from the environment.
const runtimeBase: RuntimeBase = {
  database,
  baseUrl: config.APP_URL,
  secret: deriveAuthSecret(config.ENCRYPTION_KEY),
  log,
  githubUrls: { web: config.GITHUB_URL, api: config.GITHUB_API_URL },
  sessionTtlDays: config.SESSION_TTL_DAYS,
  // A node of its own on the backplane, with no sockets: it only ever publishes.
  bus: backplane.node(() => undefined, log),
  clock: systemClock,
};
// The rest — GitHub's app, the mail relay, who may sign up — is the server's settings, in the database
// and so readable only once the migrations are in (D-179 §6). Until then the application is built
// with a stand-in that answers every use as a busy server, and readiness says why; after, a change of
// the settings swaps a new instance and relay in without a restart, each request served by the pair
// it started on (D-179 §4).
const services = runtimeServicesHolder(log, metrics.mailFailures);
/** The pair the settings make: at the start, and again for every change of them (`applySettings`). */
const servicesFor = (
  settings: ServerSettings,
  needsReentry: readonly SealedSetting[],
): RuntimeServices => runtimeServicesFrom(settings, runtimeBase, needsReentry, services.sends);

// Shutdown can arrive while migrations or settings are still awaited, before any worker exists.
let activeWorkers: Workers | undefined;
const workerLifecycle = { stopped: false };
const workers: Workers = {
  stop: async (): Promise<void> => {
    workerLifecycle.stopped = true;
    await activeWorkers?.stop();
  },
};

const app = createApp({
  composition: modules,
  moduleShares,
  ...(redis === undefined
    ? {}
    : { peersBehind: async (): Promise<number> => await peersBehind(redis) }),
  auth: services.auth,
  services,
  // The setup's steps and, later, Administration → Server change the settings through this (D-179 §4.9).
  settingsChange: {
    holder: services,
    cipher: credentialCipher(config.ENCRYPTION_KEY),
    clock: systemClock,
    log,
    build: servicesFor,
  },
  backplane,
  ...(sharing === undefined ? {} : { shared: sharing.shared }),
  config,
  log,
  clock: systemClock,
  database,
  storage,
  exportRunner: exports.start,
  personalExportRunner: exports.startPersonal,
  attention,
  metrics,
  ...(client === undefined ? {} : { client }),
  ...(push === undefined ? {} : { push }),
});

log.info('listening', { port: app.listen(config.PORT) });
// A crash stops new work at once: readiness says no and the sockets are told to come back (#634).
crash.onCrash(() => {
  void workers.stop();
  drainRefusingChanges(services, app.drain)().catch((failure: unknown) => {
    plainLog.warn('draining after a crash failed', { err: failure });
  });
});

// A restart is a reconnect, not an outage: drain, close the pool, exit (#220).
installShutdown({
  // No change of the settings starts once the process is going (D-179 §4.9).
  drain: drainRefusingChanges(services, app.drain),
  // Pushes for writes already committed, then the mail of every relay this process served with, then
  // the reports of the shutdown itself — the error tracker still has its time — then the pool.
  closeDatabase: async () => {
    suspension.stop();
    await workers.stop();
    await closeAfterDrain({ push, services, errorTracker, database, redis, moduleSet })();
  },
  log,
  process,
  deadlineMs: 10_000,
  crashed: crash.crashed,
});

/**
 * The server's settings: the environment copied in on the first start of the database and never again,
 * then read, and what the server serves with built from them. A secret sealed under another
 * `ENCRYPTION_KEY` is read as unset and the server waits in setup mode for it (R38); a setting that cannot
 * be read otherwise — a row that does not decode, a database that fails — ends the process, said, rather
 * than serving without it.
 */
const fromSettings = async (): Promise<RuntimeServices> => {
  try {
    const cipher = credentialCipher(config.ENCRYPTION_KEY);
    if (
      (await importFromEnvOnce(database, cipher, systemClock, envSeedOf(config))) === 'imported'
    ) {
      log.info(
        'the environment was copied into the server settings; from now on they are read there',
      );
    } else {
      const ignored = ignoredEnvironment(config);
      // Names only: an operator who edited one is told it does nothing (CONFIG.md).
      if (ignored.length > 0) {
        log.info("settings are the database's; these variables are ignored", {
          variables: ignored,
        });
      }
    }
    const { settings, needsReentry } = await readSettingsToBoot(database, cipher);
    if (needsReentry.length > 0) {
      // A rotated ENCRYPTION_KEY: the server starts in setup mode with these read as unset, and the
      // wizard asks for them again. Which settings, never a value; nothing is deleted (CONFIG.md).
      log.warn('a secret in the server settings cannot be opened and is treated as unset', {
        settings: needsReentry,
        action: 'enter it again in the browser, or put the previous ENCRYPTION_KEY back',
        see: 'CONFIG.md, "What stays in the environment": the recovery after ENCRYPTION_KEY changes',
      });
    }
    return servicesFor(settings, needsReentry);
  } catch (error) {
    // Anything but a secret that will not open: a row that does not decode, a database that fails.
    log.error('the server settings could not be read; exiting', { err: error });
    process.exit(1);
  }
};

// After the listener is open, so liveness answers during a long migration and
// readiness says 503 until it finishes (D-93). Nodes started together take turns
// in the migrator's own lock. A node that cannot migrate must not keep running as
// though it could.
if (config.MIGRATE_ON_START === true) {
  try {
    const applied = await migrateOnStart(connection, undefined, {
      sets: modules.migrationSets,
      // A deadlock against live traffic ends the migration's attempt, not the start (D-86).
      onRetry: (retry) => {
        log.warn('a migration was ended as a deadlock victim and is being retried', {
          migration: retry.migration,
          attempt: retry.attempt,
          pauseMilliseconds: retry.pauseMilliseconds,
          err: retry.error,
        });
      },
    });
    log.info('migrations are current', { applied });
  } catch (error) {
    log.error('migrating on start failed; exiting', { err: error });
    process.exit(1);
  }
} else {
  // Somebody else migrates — an operator, another node: the settings are read once they have.
  await untilMigrated(database, log, undefined, modules.migrationSets);
}

const runtime = await fromSettings();
if (config.MIGRATE_ON_START === true) {
  // The schema is the one this code ships now, so the sign-in library's comparison of it with what
  // it expects is a verdict: it would only log a mismatch and then fail every sign-in, so a mismatch
  // ends the process here. Not asked before the migrations are in — the library keeps a mismatch
  // until a restart — and without a migration on start, readiness asks it once they are (D-179).
  const signInProblem = await runtime.auth.schemaProblem();
  if (signInProblem !== undefined) {
    log.error('the sign-in library cannot work on this database; exiting', {
      reason: signInProblem,
    });
    process.exit(1);
  }
}
services.settle(runtime);
// From here the table exists: the stopped modules are kept within the TTL on this node whether or not anything asks.
suspension.start();
// What the modules that run do on a timer, each iteration held to its module's share and deadline (`modules/workers`).
if (!workerLifecycle.stopped) {
  activeWorkers = startWorkers(modules.workers, {
    database: leasingExecutor(database, moduleShares),
    clock: systemClock,
    log,
    bus: runtimeBase.bus,
    failures: metrics.workerFailures,
    outbox: { delivered: metrics.outboxDelivered, failures: metrics.outboxFailures },
    ...(push === undefined ? {} : { push }),
  });
}
// Sign-in by email (#81, D-138 §6): on where the settings name a relay and its sender.
log.info(
  runtime.mail === undefined ? 'email sign-in is off: no mail relay is set' : 'email sign-in is on',
);
log.info(
  runtime.auth.github
    ? 'GitHub sign-in is on'
    : 'GitHub sign-in is off: no GitHub app is connected',
);
// Not awaited: the server serves whatever the relay says, and the log says it.
if (runtime.mailer !== undefined) void checkRelay(runtime.mailer, log);

// The setup in the browser (D-179 §4): while the server has no user but the one its setup made and the
// setup is not finished, every start writes a new one-time code to the log — after the migrations and
// the settings, so the row is there to hold its digest. A closed server writes nothing, and a code that
// could not be issued is said while the server serves on: the next start issues one again.
try {
  await issueSetupCode(database, log, systemClock);
} catch (error) {
  log.error('the setup code could not be issued; restart the server for one', { err: error });
}
