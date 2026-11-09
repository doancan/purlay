/**
 * One error handler for the whole surface, so a status is decided in exactly
 * one place. `set.status` rather than a thrown response: a second way to
 * choose a status is a second place for two of them to disagree.
 */
import type { ErrorHandler } from 'elysia';
import {
  GITHUB_APP_CALLBACK,
  GOOGLE_CALLBACK,
  OIDC_CALLBACK,
  SIGN_IN_CALLBACK,
} from '@purlay/types';
import type { Composition } from '../../composition';
import { AppError } from '../../platform/errors';
import { goneMessageReference } from '../../platform/gone-message';
import type { Logger } from '../../platform/logging';
import type { ServerMetrics } from '../../platform/metrics';
import { FACT_BACKLOG_RETRY_AFTER_SECONDS, FactBacklogFull } from '../../platform/outbox';
import { abandonSignIn } from './auth';
import type { LeasedDependencies } from './dependencies';
import { refusalFor } from './errors';
import type { RequestObservation } from './request-observation';
import { respond } from './route-answers';

/** What the handler answers: the body of a refusal, or the empty answer of a redirect. */
type ErrorBody = ReturnType<typeof refusalFor>['body'] | string;

export const errorHook = (input: {
  readonly dependencies: LeasedDependencies;
  readonly modules: Composition;
  readonly log: Logger;
  readonly metrics: ServerMetrics;
  readonly observation: RequestObservation;
}) => {
  const { dependencies, modules, log, metrics, observation } = input;
  const { moduleOfRoute, moduleField, writtenPath } = observation;
  return ({ code, error, set, path, route }: Parameters<ErrorHandler>[0]): ErrorBody => {
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
    if (error instanceof FactBacklogFull) {
      set.headers['retry-after'] = String(FACT_BACKLOG_RETRY_AFTER_SECONDS);
      // The client is told to wait; which workspace and which consumer is for the operator.
      log.warn('a fact was refused: the consumer’s backlog in the workspace is full', {
        path: where,
        fact: error.type,
        workspaceId: error.workspaceId,
        consumer: error.consumer,
        ceiling: error.ceiling,
        ...moduleField(route),
      });
    }
    set.status = refusal.status;
    return refusal.body;
  };
};
