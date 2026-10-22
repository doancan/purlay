/**
 * Structured logging, and the request a line belongs to (`ARCHITECTURE.md` §10).
 *
 * **One facade over the logger, and everything passes through it.** The spike
 * found that `pino`'s own formatting hooks do not see a child logger's bindings —
 * `child({ email })` reached the output unredacted with both hooks set — and that
 * an `Error` serialises as `{}` (`docs/spikes/pino.md`). So nothing here hands the
 * library a value it has not already cleaned: fields and bindings alike go
 * through `clean` first, and an error becomes its name, message and stack.
 *
 * **What is never logged is a list in code, not a sentence in a document.** Any
 * field so named, at any depth, is replaced before it is written. A value
 * interpolated into the message text cannot be found this way, which is why a
 * message is a constant and the variables go in fields.
 *
 * **The request a line belongs to is carried, not passed.** Every HTTP request
 * and socket frame runs in a scope holding its request id, and every line written
 * inside it carries the id — including lines from a service several calls down
 * that has never heard of a request. Threading it through signatures instead
 * would put a transport concept into every module's arguments (D-71).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

/** Never written to a log, at any depth (`ARCHITECTURE.md` §10). */
export const NEVER_LOGGED: ReadonlySet<string> = new Set([
  'token',
  'sessionToken',
  'cookie',
  'authorization',
  'accessToken',
  'access_token',
  'access_token_encrypted',
  // A repository feed's webhook secret, sealed (D-134 §3).
  'secret_encrypted',
  // The server's settings (D-179 §6): the GitHub app's secret and the relay's address, which carries
  // its password — as read (`ServerSettings`) and as stored, sealed.
  'clientSecret',
  'smtpUrl',
  'smtp_url',
  'github_client_secret_encrypted',
  'smtp_url_encrypted',
  // A delivery's signature: an HMAC of its body under the secret (D-134 §4).
  'signature',
  'email',
  'content',
  'password',
  'secret',
  'code',
  // A device's push subscription: the address that reaches it, and the keys that encrypt to it (D-126).
  'endpoint',
  'p256dh',
  'auth',
  // A person's status line: free words, as a message's are (D-131).
  'status_text',
  // A mail and what a relay says of it — the recipient and the sign-in link it carries (D-138 §8).
  'to',
  'envelope',
  'html',
  'text',
  'token_hash',
  // The setup's claim, as handed to the browser (D-179 §4.2). The setup *code* is not here, on purpose:
  // the log at a start is the one place it is shown, under its own field, `setupCode`
  // (`modules/setup/setup.ts`).
  'claimToken',
]);

const REDACTED = '[redacted]';

/** Deep enough for any object this application logs; a cycle stops here rather than recursing. */
const MAX_DEPTH = 8;

const errorCode = (error: Error): { errorCode?: string | number } => {
  const code: unknown = 'code' in error ? error.code : undefined;
  return typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {};
};

/** A value made safe to write: secrets replaced, errors made legible, depth bounded. */
export const clean = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return '[too deep]';
  if (value instanceof Error) {
    return {
      type: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
      ...(value.cause === undefined ? {} : { cause: clean(value.cause, depth + 1) }),
      // `pg` throws an AggregateError with an empty message when a host resolves to
      // several addresses and none answers; everything useful is in `errors`.
      ...(value instanceof AggregateError
        ? { errors: value.errors.map((inner: unknown) => clean(inner, depth + 1)) }
        : {}),
      // Under another name: the key `code` is on the never-logged list (an OAuth
      // code), and a system error's code (ECONNREFUSED, 23505) is not that.
      ...errorCode(value),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item: unknown) => clean(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        NEVER_LOGGED.has(key) ? REDACTED : clean(item, depth + 1),
      ]),
    );
  }
  return value;
};

export type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly debug: (message: string, fields?: Fields) => void;
  readonly info: (message: string, fields?: Fields) => void;
  readonly warn: (message: string, fields?: Fields) => void;
  readonly error: (message: string, fields?: Fields) => void;
  /** A logger whose every line carries these fields — cleaned like any other. */
  readonly child: (bindings: Fields) => Logger;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** What a request's lines share. */
export interface RequestScope {
  readonly requestId: string;
  readonly startedAt: number;
  /**
   * The session the request was made with, once something has proved it — `requireSession` for HTTP,
   * the upgrade for a socket. What the audit trail names as who acted (D-116); never logged.
   */
  sessionId?: string;
}

const scope = new AsyncLocalStorage<RequestScope>();

/**
 * Runs `body` as one request. Used where the caller owns the call — a socket frame.
 * An HTTP request is entered from the framework's first hook instead (`enterRequest`).
 */
export const withinRequest = <T>(request: RequestScope, body: () => T): T =>
  scope.run(request, body);

/**
 * Makes the rest of this asynchronous flow one request. The framework offers no
 * hook *around* a request, only a first one; entering from it is what carries the
 * scope to the handler — measured under concurrency in the spike, with no two
 * requests seeing each other's.
 */
export const enterRequest = (request: RequestScope): void => {
  scope.enterWith(request);
};

export const currentRequest = (): RequestScope | undefined => scope.getStore();

/** Notes the session this request was proved to be made with; outside a request there is none to note. */
export const noteSession = (sessionId: string): void => {
  const request = scope.getStore();
  if (request !== undefined) request.sessionId = sessionId;
};

const wrap = (instance: pino.Logger): Logger => {
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields?: Fields): void => {
      if (fields === undefined) instance[level](message);
      else instance[level](clean(fields) as Record<string, unknown>, message);
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (bindings) => wrap(instance.child(clean(bindings) as Record<string, unknown>)),
  };
};

/**
 * The logger. One line of JSON per call, written synchronously so a crash
 * cannot lose the lines that explain it. `write` is where the lines go — standard
 * output in production, an array in a test.
 */
export const createLogger = (options: {
  readonly level: LogLevel;
  readonly write?: (line: string) => void;
}): Logger => {
  const destination =
    options.write === undefined
      ? pino.destination({ dest: 1, sync: true })
      : { write: options.write };
  return wrap(
    pino(
      {
        level: options.level,
        base: null,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        // The library re-serialises a field named `err` after `clean` already has,
        // turning its type into "Object" and folding the cause into the message.
        // One serialiser, and it is this module's.
        serializers: { err: (value: unknown): unknown => value },
        mixin: () => {
          const request = scope.getStore();
          return request === undefined ? {} : { requestId: request.requestId };
        },
      },
      destination,
    ),
  );
};
