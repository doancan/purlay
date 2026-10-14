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
import { exportQueue } from './modules/export/requests';
import { checkRelay, outbox, smtpMailer } from './platform/mail';
import { createDatabase } from '@purlay/db';
import { databaseConnection } from './platform/database';
import { loadConfig } from './platform/config';
import { systemClock } from './platform/clock';
import { githubClient } from './modules/auth/github';
import { SIGN_IN_CALLBACK } from './modules/auth/sign-in';
import { createApp } from './ingress/http/app';
import { createLogger } from './platform/logging';
import { createErrorTracker, fetchDelivery, withErrorTracking } from './platform/error-tracking';
import { installShutdown } from './lifecycle';
import { migrateOnStart } from './platform/migrate-on-start';
import { openClient } from './ingress/http/client';
import { storeFor } from './platform/storage';
import { PUSH_TIMEOUT_MS, createPushSender } from './modules/push/sender';
import { checkingLookup, postExternal, systemResolver } from './modules/images/fetch-external';

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

// Sign-in by email (#81, D-138 §6): on with both of SMTP_URL and MAIL_FROM, which the configuration
// has checked come together.
const mailer =
  config.SMTP_URL === undefined || config.MAIL_FROM === undefined
    ? undefined
    : smtpMailer({
        SMTP_URL: config.SMTP_URL,
        MAIL_FROM: config.MAIL_FROM,
        SMTP_ALLOW_PLAINTEXT: config.SMTP_ALLOW_PLAINTEXT,
      });
const mail = mailer === undefined ? undefined : outbox(mailer.send, log);
log.info(mail === undefined ? 'email sign-in is off: no SMTP_URL' : 'email sign-in is on');
// Not awaited: the server starts whatever the relay says, and the log says it.
if (mailer !== undefined) void checkRelay(mailer, log);

// An owner's exports, one at a time, made by this process after answering (D-140).
const storage = storeFor(config);
const exports = exportQueue({ database, clock: systemClock, log, storage });

const app = createApp({
  config,
  log,
  clock: systemClock,
  database,
  storage,
  exportRunner: exports.start,
  ...(client === undefined ? {} : { client }),
  ...(push === undefined ? {} : { push }),
  ...(mail === undefined ? {} : { mail }),
  github: githubClient({
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    // One origin, so this is the origin the browser is already on (D-61).
    redirectUri: `${config.APP_URL}${SIGN_IN_CALLBACK}`,
  }),
});

log.info('listening', { port: app.listen(config.PORT) });

// A restart is a reconnect, not an outage: drain, close the pool, exit (#220).
installShutdown({
  drain: app.drain,
  closeDatabase: async () => {
    // Pushes for writes already committed, within their own bound, then the reports of the
    // shutdown itself: the error tracker still has its time.
    await push?.flush();
    // Sign-in links answered already: their mail goes before the process does, within its bound.
    await mail?.flush();
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
