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

interface TrackedError {
  /** The log message: a constant, by the logger's own rule. */
  readonly message: string;
  /** Already cleaned. */
  readonly fields: Fields;
}

export interface ErrorTracker {
  /** Fire and forget; never throws. */
  readonly capture: (error: TrackedError) => void;
  /**
   * For shutdown: waits for the reports in flight, but no longer than `boundMs`, then
   * abandons what is left. A collector that never answers must not hold a restart.
   */
  readonly flush: (boundMs?: number) => Promise<void>;
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

/** How long one report may take before it is given up on. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** How long `flush` waits for reports in flight when the process is ending. */
const DEFAULT_FLUSH_BOUND_MS = 2_000;
/** Dropped reports are announced at most this often. */
const DROP_NOTICE_INTERVAL_MS = 60_000;

export type Delivery = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
    /** Aborted when the report has taken too long, or the process is ending. */
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly ok: boolean }>;

/**
 * The delivery the process uses: `fetch`, which does not follow a redirect (a report
 * goes to the host in the DSN and nowhere else, whatever that host says) and ends when
 * the signal does. A redirect is a status outside 200-299, so it is a refusal.
 */
export const fetchDelivery: Delivery = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  return { ok: response.ok };
};

export interface ErrorTrackerOptions {
  /** `ERROR_TRACKING_DSN`. Undefined or empty means off. */
  readonly dsn: string | undefined;
  readonly environment: string;
  readonly clock: Clock;
  readonly send: Delivery;
  /** A report could not be delivered. Must not log at `error`. */
  readonly onFailure?: (error: unknown) => void;
  /**
   * Reports were discarded because too many were outstanding; called with the running
   * total, at most once a minute. Must not log at `error`.
   */
  readonly onDropped?: (total: number) => void;
  readonly maxInFlight?: number;
  /** Per report. Default five seconds. */
  readonly timeoutMs?: number;
  /** The directory paths in a stack are made relative to. Default: the working directory. */
  readonly root?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Where a path on this machine can start. */
const HOST_LOCATIONS =
  /^\/(?:Users|home|root|app|opt|usr|var|tmp|private|srv|mnt|workspace|builds|runner|Library|etc)\//;

/**
 * Absolute paths made harmless: relative to `root` when inside it, to the package when
 * inside `node_modules`, otherwise only the file name. A stack names the machine it
 * ran on; the report does not need to. A path must start where text does, or after a
 * space, quote or bracket, so `https://host/path` is left alone.
 */
export const scrubPaths = (text: string, root: string = process.cwd()): string => {
  const prefix = `${root.replace(/\/+$/, '')}/`;
  return text.replace(/(?<=^|[\s('"=[])(\/[\w.@+~-]+(?:\/[\w.@+~-]+)+)/g, (path) => {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
    const inModules = path.lastIndexOf('/node_modules/');
    if (inModules !== -1) return path.slice(inModules + 1);
    // A request path such as `/api/channels` is not a place on this machine; only
    // locations where code, homes and temporary files live are.
    return HOST_LOCATIONS.test(path) ? `…/${path.slice(path.lastIndexOf('/') + 1)}` : path;
  });
};

const scrubDeep = (value: unknown, root: string, depth = 0): unknown => {
  if (typeof value === 'string') return scrubPaths(value, root);
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubDeep(item, root, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeep(item, root, depth + 1)]),
    );
  }
  return value;
};

/** The Sentry event for a logged error. */
const toEvent = (
  error: TrackedError,
  context: {
    readonly id: string;
    readonly timestamp: string;
    readonly environment: string;
    readonly root: string;
  },
): Record<string, unknown> => {
  const { err, ...rest } = error.fields;
  const described = isRecord(err) ? err : undefined;
  const type = typeof described?.['type'] === 'string' ? described['type'] : 'Error';
  const value = typeof described?.['message'] === 'string' ? described['message'] : error.message;
  const stack = typeof described?.['stack'] === 'string' ? described['stack'] : undefined;
  const extra = scrubDeep(
    { ...rest, ...(stack === undefined ? {} : { stack }) },
    context.root,
  ) as Record<string, unknown>;
  const scrub = (text: string): string => scrubPaths(text, context.root);

  return {
    event_id: context.id,
    timestamp: context.timestamp,
    platform: 'javascript',
    level: 'error',
    environment: context.environment,
    message: scrub(error.message),
    ...(described === undefined ? {} : { exception: { values: [{ type, value: scrub(value) }] } }),
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = options.root ?? process.cwd();
  const inFlight = new Set<Promise<void>>();
  // Ended when the process is, so what a silent collector still holds is let go.
  const abandon = new AbortController();
  let dropped = 0;
  let lastNotice: number | undefined;

  const fail = (reason: unknown): void => {
    options.onFailure?.(reason);
  };

  return {
    capture: (error): void => {
      if (inFlight.size >= maxInFlight) {
        dropped += 1;
        const now = options.clock.now().getTime();
        if (lastNotice === undefined || now - lastNotice >= DROP_NOTICE_INTERVAL_MS) {
          lastNotice = now;
          options.onDropped?.(dropped);
        }
        return;
      }
      const id = crypto.randomUUID().replaceAll('-', '');
      const timestamp = options.clock.now().toISOString();
      const event = toEvent(error, { id, timestamp, environment: options.environment, root });
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
            signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), abandon.signal]),
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
    flush: async (boundMs = DEFAULT_FLUSH_BOUND_MS): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundMs);
      });
      await Promise.race([Promise.allSettled([...inFlight]), bound]);
      clearTimeout(timer);
      // Whatever is still out is abandoned, and settles as a failure now.
      abandon.abort();
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
