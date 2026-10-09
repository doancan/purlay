/**
 * Error tracking behind a facade (#248, D-96).
 *
 * **Off unless asked for.** With no `ERROR_TRACKING_DSN` there is no tracker: the
 * logger is returned untouched and nothing leaves the process. A self-hosted
 * deployment never has one by default, and no telemetry is collected from it
 * (D-44).
 *
 * **No vendor library.** A tracker that speaks the Sentry envelope format — which
 * Sentry, GlitchTip and others accept — is a hundred lines over `fetch`, and a
 * dependency on an SDK would be a runtime dependency with its own supply chain
 * for the one thing this module does (CONTRIBUTING §1.12).
 *
 * **It sends what the log would write, and nothing else.** The seam is the logger:
 * whatever is logged at `error` — a failed request, a failed socket frame, a
 * failed shutdown — passes through `clean`, which removes everything on the
 * never-logged list, and the same cleaned value is what is sent. There is no
 * second place an error is described, so there is no second place a secret can
 * leak from.
 *
 * **It can never make the process worse.** A report that cannot be delivered is
 * counted and handed to `onFailure`, never thrown, never retried in a loop, and
 * never logged at `error` (which would report the failure of reporting). At most
 * `maxInFlight` reports are outstanding; a burst beyond it is dropped and counted
 * rather than queued, because an error storm is when memory is least available.
 */
import type { Clock } from './clock';
import { clean, currentRequest, type Fields, type Logger } from './logging';

export class ErrorTrackingConfigurationError extends Error {
  constructor(problem: string) {
    super(`ERROR_TRACKING_DSN: ${problem}`);
    this.name = 'ErrorTrackingConfigurationError';
  }
}

export interface ParsedDsn {
  readonly key: string;
  readonly endpoint: string;
}

/**
 * `https://<public key>@<host>[/<prefix>]/<project id>`. Refusals name the
 * variable and say what is wrong; they never repeat the value, whose key is a
 * credential (it is not secret in Sentry's model, but it is not ours to print).
 */
export const parseDsn = (dsn: string): ParsedDsn => {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new ErrorTrackingConfigurationError('is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ErrorTrackingConfigurationError('must be an http(s) URL');
  }
  if (url.username === '') {
    throw new ErrorTrackingConfigurationError('has no public key before the host');
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const project = segments.pop();
  if (project === undefined || !/^\d+$/.test(project)) {
    throw new ErrorTrackingConfigurationError('must end in a numeric project id');
  }
  const prefix = segments.length === 0 ? '' : `/${segments.join('/')}`;
  return {
    key: decodeURIComponent(url.username),
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`,
  };
};

export interface TrackedError {
  /** The log message: a constant, by the logger's own rule. */
  readonly message: string;
  /** Already cleaned. */
  readonly fields: Fields;
}

export interface ErrorTracker {
  /** Fire and forget; never throws. */
  readonly capture: (error: TrackedError) => void;
  /** Resolves once every report in flight has settled. For shutdown. */
  readonly flush: () => Promise<void>;
  /** Reports discarded because too many were outstanding. */
  readonly dropped: () => number;
}

/** The tracker for a process that has none. */
export const noErrorTracking: ErrorTracker = {
  capture: (): void => undefined,
  flush: async (): Promise<void> => {
    await Promise.resolve();
  },
  dropped: (): number => 0,
};

export type Delivery = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<{ readonly ok: boolean }>;

export interface ErrorTrackerOptions {
  /** `ERROR_TRACKING_DSN`. Undefined or empty means off. */
  readonly dsn: string | undefined;
  readonly environment: string;
  readonly clock: Clock;
  readonly send: Delivery;
  /** A report could not be delivered. Must not log at `error`. */
  readonly onFailure?: (error: unknown) => void;
  readonly maxInFlight?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The Sentry event for a logged error. */
const toEvent = (
  error: TrackedError,
  context: { readonly id: string; readonly timestamp: string; readonly environment: string },
): Record<string, unknown> => {
  const { err, ...rest } = error.fields;
  const described = isRecord(err) ? err : undefined;
  const type = typeof described?.['type'] === 'string' ? described['type'] : 'Error';
  const value = typeof described?.['message'] === 'string' ? described['message'] : error.message;
  const stack = typeof described?.['stack'] === 'string' ? described['stack'] : undefined;
  const extra = { ...rest, ...(stack === undefined ? {} : { stack }) };

  return {
    event_id: context.id,
    timestamp: context.timestamp,
    platform: 'javascript',
    level: 'error',
    environment: context.environment,
    message: error.message,
    ...(described === undefined ? {} : { exception: { values: [{ type, value }] } }),
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
};

export const createErrorTracker = (options: ErrorTrackerOptions): ErrorTracker => {
  if (options.dsn === undefined || options.dsn === '') return noErrorTracking;

  const { key, endpoint } = parseDsn(options.dsn);
  // An error report holds stack traces and the fields the log would write; sent in
  // the clear it is a leak with a schedule.
  if (options.environment === 'production' && !endpoint.startsWith('https:')) {
    throw new ErrorTrackingConfigurationError('must be https:// in production');
  }

  const maxInFlight = options.maxInFlight ?? 10;
  const inFlight = new Set<Promise<void>>();
  let dropped = 0;

  const fail = (reason: unknown): void => {
    options.onFailure?.(reason);
  };

  return {
    capture: (error): void => {
      if (inFlight.size >= maxInFlight) {
        dropped += 1;
        return;
      }
      const id = crypto.randomUUID().replaceAll('-', '');
      const timestamp = options.clock.now().toISOString();
      const event = toEvent(error, { id, timestamp, environment: options.environment });
      const body = [
        JSON.stringify({ event_id: id, sent_at: timestamp }),
        JSON.stringify({ type: 'event' }),
        JSON.stringify(event),
      ].join('\n');

      const delivery = (async (): Promise<void> => {
        try {
          const response = await options.send(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-sentry-envelope',
              'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=purlay/1, sentry_key=${key}`,
            },
            body,
          });
          if (!response.ok) fail(new Error('the error tracker refused a report'));
        } catch (reason) {
          fail(reason);
        }
      })().finally(() => {
        inFlight.delete(delivery);
      });
      inFlight.add(delivery);
    },
    flush: async (): Promise<void> => {
      await Promise.allSettled([...inFlight]);
    },
    dropped: (): number => dropped,
  };
};

/**
 * The logger, also reporting whatever it is asked to log at `error`. With no
 * tracker it is returned as it came: switching tracking off removes the code path,
 * not a flag inside it.
 */
export const withErrorTracking = (
  log: Logger,
  tracker: ErrorTracker,
  bindings: Fields = {},
): Logger => {
  if (tracker === noErrorTracking) return log;
  return {
    debug: log.debug,
    info: log.info,
    warn: log.warn,
    error: (message, fields): void => {
      log.error(message, fields);
      try {
        // The id the log line carries, so a report and its line are found from each other.
        const requestId = currentRequest()?.requestId;
        const merged = {
          ...bindings,
          ...(requestId === undefined ? {} : { requestId }),
          ...(fields ?? {}),
        };
        tracker.capture({ message, fields: clean(merged) as Fields });
      } catch (reason) {
        // A bug in the tracker must not lose the line above or stop the caller.
        // Reported at `warn`: an `error` here would be reported in turn.
        log.warn('error tracking failed', { err: reason });
      }
    },
    child: (childBindings): Logger =>
      withErrorTracking(log.child(childBindings), tracker, { ...bindings, ...childBindings }),
  };
};
