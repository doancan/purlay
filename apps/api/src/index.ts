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
import { createDatabase, readCaFile } from '@purlay/db';
import { loadConfig } from './platform/config';
import { systemClock } from './platform/clock';
import { githubClient } from './modules/auth/github';
import { createApp } from './ingress/http/app';
import { createLogger } from './platform/logging';
import { createErrorTracker, fetchDelivery, withErrorTracking } from './platform/error-tracking';
import { installShutdown } from './lifecycle';
import { migrateOnStart } from './platform/migrate-on-start';
import { openJoinNotice } from './modules/workspaces/open-join';
import { openClient } from './ingress/http/client';
import { storeFor } from './platform/storage';

const config = loadConfig(process.env);
const plainLog = createLogger({ level: config.LOG_LEVEL });

// Off unless ERROR_TRACKING_DSN is set (D-96). A DSN that cannot be parsed refuses
// to start, here, rather than failing quietly at the first error. Everything logged
// at `error` below is also reported, cleaned the way the log is.
const errorTracker = createErrorTracker({
  dsn: config.ERROR_TRACKING_DSN,
  environment: config.NODE_ENV,
  clock: systemClock,
  send: fetchDelivery,
  // At `warn`: a failed report must not be reported in turn.
  onFailure: (reason) => {
    plainLog.warn('an error report was not delivered', { err: reason });
  },
  onDropped: (total) => {
    plainLog.warn('error reports are being dropped; the collector is not keeping up', { total });
  },
});
const log = withErrorTracking(plainLog, errorTracker);

// Which workspace is open, said before anything else (D-37).
log.info(openJoinNotice(config.WORKSPACE_OPEN_JOIN_SLUG));

// Opened before anything listens: a build without its shell refuses to start (D-61).
const client = config.CLIENT_DIST === undefined ? undefined : openClient(config.CLIENT_DIST);
log.info(
  client === undefined ? 'no client is served: CLIENT_DIST is unset' : 'serving the client',
  client === undefined ? {} : { dist: client.dist },
);

// How to reach the database, for the application's pool and for the connection a
// migration on start opens for itself (D-87): the same place, the same TLS.
const connection = {
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL,
  ...(config.DATABASE_SSL_CA_FILE === undefined
    ? {}
    : { sslCa: readCaFile(config.DATABASE_SSL_CA_FILE) }),
  // Reported and carried on: the pool replaces the dead connection by itself.
  onPoolError: (error: Error): void => {
    log.error('database pool error', { error });
  },
};

const database = createDatabase({ ...connection, poolSize: config.DATABASE_POOL_MAX });

const app = createApp({
  config,
  log,
  clock: systemClock,
  database,
  storage: storeFor(config),
  ...(client === undefined ? {} : { client }),
  github: githubClient({
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    // One origin, so this is the origin the browser is already on (D-61).
    redirectUri: `${config.APP_URL}/auth/github/callback`,
  }),
});

log.info('listening', { port: app.listen(config.PORT) });

// A restart is a reconnect, not an outage: drain, close the pool, exit (#220).
installShutdown({
  drain: app.drain,
  closeDatabase: async () => {
    // Reports of the shutdown itself are still in flight.
    await errorTracker.flush();
    await database.destroy();
  },
  log,
  process,
  deadlineMs: 10_000,
});

// After the listener is open, so liveness answers during a long migration and
// readiness says 503 until it finishes (D-93). Nodes started together take turns
// in the migrator's own lock. A node that cannot migrate must not keep running as
// though it could.
if (config.MIGRATE_ON_START === true) {
  try {
    const applied = await migrateOnStart(connection, undefined, {
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
}
