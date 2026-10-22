/**
 * One way to call the API, and the one place a response is believed.
 *
 * Same origin, cookie credentials, JSON in and out (`API.md` §1). A response is
 * checked against the contract's schema before anything else sees it: a body that
 * fails is `MALFORMED`, never partly used — the browser is the trust boundary the
 * server's own validation cannot reach. The error body is parsed the same way, so
 * `code` is always a member of the closed set or one of the two the client adds
 * (`errors.ts`).
 *
 * `fetch` is an argument, so a test answers with whatever it likes and no test
 * ever waits on a network.
 */
import { Value } from '@sinclair/typebox/value';
import { AppErrorBody } from '@purlay/types';
import type { Static, TSchema } from '@sinclair/typebox';
import type { Schedule } from '../realtime/connection';
import { browserSchedule } from '../realtime/socket';
import { ApiError, LibraryFailure } from './errors';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** Appended as a query string; `undefined` values are left out. */
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /** A file's bytes, sent as they are — an upload's body (D-109 §3), never JSON. */
  readonly bytes?: Blob;
  /** Aborts the request — what TanStack Query hands a query function. */
  readonly signal?: AbortSignal;
}

export interface Http {
  /** The response must satisfy `schema`. */
  readonly request: <S extends TSchema>(
    method: Method,
    path: string,
    schema: S,
    options?: RequestOptions,
  ) => Promise<Static<S>>;
  /**
   * A POST to one of the sign-in library's own routes (`/auth/sign-in/email`, `/auth/change-password`):
   * the answer is not read, and a refusal is the library's shape, `LibraryFailure`.
   */
  readonly library: (path: string, body: unknown) => Promise<void>;
  /** For an endpoint whose answer is not read (a sign-out). */
  readonly send: (method: Method, path: string, options?: RequestOptions) => Promise<void>;
  /**
   * A file's bytes, posted, with its progress told as it goes (#388) — `fetch` reports nothing of a
   * request body until the answer, so an upload takes the transport that does. Its answer and its
   * failures are read as a request's are.
   */
  readonly upload: <S extends TSchema>(
    path: string,
    schema: S,
    bytes: Blob,
    options: UploadOptions,
  ) => Promise<Static<S>>;
}

interface UploadOptions {
  readonly query?: RequestOptions['query'];
  /** Bytes sent of the total, whenever the browser can measure them. */
  readonly onProgress?: (sent: number, total: number) => void;
}

/** The part of `XMLHttpRequest` an upload uses; the browser's satisfies it, and so does a test's. */
export interface UploadRequest {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null };
  onload: ((event: ProgressEvent) => void) | null;
  onerror: ((event: ProgressEvent) => void) | null;
  readonly status: number;
  readonly responseText: string;
  open: (method: string, url: string) => void;
  setRequestHeader: (name: string, value: string) => void;
  send: (body: Blob) => void;
}

const withQuery = (path: string, query: RequestOptions['query']): string => {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? path : `${path}?${text}`;
};

const unreadable = (status: number, what = 'something unreadable'): ApiError =>
  new ApiError(status, 'MALFORMED', `The server answered with ${what}.`);

/**
 * A proxy's own answer for an API it could not reach — down, restarting, too slow. The request never
 * reached the application, so it is the network's failure and a retry may mend it; anything else
 * unreadable is the application answering with something the client does not understand.
 */
const GATEWAY = new Set([502, 503, 504]);

const unanswered = (status: number): ApiError =>
  GATEWAY.has(status)
    ? new ApiError(status, 'NETWORK', 'The server could not be reached.')
    : unreadable(status);

/** A refusal of one of the library's routes: `{ code, message, reason? }`, and `Retry-After` on a 429. */
const libraryFailureOf = (
  status: number,
  text: string,
  retryAfter: string | null,
): LibraryFailure => {
  const wait = retryAfter !== null && /^\d{1,7}$/.test(retryAfter) ? Number(retryAfter) : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new LibraryFailure(status, GATEWAY.has(status) ? 'NETWORK' : 'MALFORMED', null, wait);
  }
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const code = typeof record['code'] === 'string' ? record['code'] : null;
  if (code === null) return new LibraryFailure(status, 'MALFORMED', null, wait);
  const reason = typeof record['reason'] === 'string' ? record['reason'] : null;
  return new LibraryFailure(status, code, reason, wait);
};

/** An error answer, read the same whichever transport carried it. */
const failureOf = (status: number, text: string): ApiError => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unanswered(status);
  }
  const body: unknown =
    typeof parsed === 'object' && parsed !== null && 'error' in parsed ? parsed.error : undefined;
  if (!Value.Check(AppErrorBody, body)) return unanswered(status);
  return new ApiError(
    status,
    body.code,
    body.message,
    body.code === 'VALIDATION_FAILED' ? body.details.fields : {},
    undefined,
    body.code === 'LAST_OWNER' ? (body.details?.workspaceIds ?? []) : [],
    body.code === 'STORAGE_QUOTA_EXCEEDED' ? (body.details?.remainingBytes ?? null) : null,
  );
};

/** A successful answer, believed only once it satisfies the contract's schema. */
const answerOf = <S extends TSchema>(status: number, text: string, schema: S): Static<S> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable(status);
  }
  if (!Value.Check(schema, value)) {
    throw unreadable(status, 'something the client does not understand');
  }
  return value;
};

/** The part of `fetch` this client uses; the browser's satisfies it, and so does a test's. */
export type FetchPort = (input: string, init: RequestInit) => Promise<Response>;

/**
 * How long a write may go unanswered before it is given up as `NETWORK` (#604) — the failure every
 * action already says and offers to retry. Without it a request the network never answers holds an
 * action that sends one at a time (Save, Pin) until the page is reloaded. A read is not bounded here:
 * its query owns its signal. An upload neither: it says its progress, and a large one is slow, not lost.
 */
export const WRITE_DEADLINE_MS = 30_000;

export const createHttp = (
  fetchFn: FetchPort,
  // Looked up when an upload is made, not when the client is: the build prerenders with no window.
  newUpload: () => UploadRequest = () => new XMLHttpRequest(),
  // The timers a write's deadline runs on: the browser's, or a test's that moves when told.
  schedule: Schedule = browserSchedule,
): Http => {
  /** The answer, read whole: a deadline holds until the last byte, not only the headers. */
  const call = async (
    method: Method,
    path: string,
    options: RequestOptions,
  ): Promise<{ readonly status: number; readonly text: string }> => {
    if (method === 'GET') return await exchange(method, path, options, options.signal);
    const deadline = new AbortController();
    const forward = (): void => {
      deadline.abort();
    };
    options.signal?.addEventListener('abort', forward);
    const cancel = schedule(forward, WRITE_DEADLINE_MS);
    try {
      return await exchange(method, path, options, deadline.signal);
    } finally {
      cancel();
      options.signal?.removeEventListener('abort', forward);
    }
  };

  const exchange = async (
    method: Method,
    path: string,
    options: RequestOptions,
    signal: AbortSignal | undefined,
    refusal: (status: number, text: string, response: Response) => Error = (status, text) =>
      failureOf(status, text),
  ): Promise<{ readonly status: number; readonly text: string }> => {
    const hasBody = options.body !== undefined;
    const sent: { type: string; body: BodyInit } | null =
      options.bytes !== undefined
        ? { type: 'application/octet-stream', body: options.bytes }
        : hasBody
          ? { type: 'application/json', body: JSON.stringify(options.body) }
          : null;
    let response: Response;
    try {
      response = await fetchFn(withQuery(path, options.query), {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(sent === null ? {} : { 'content-type': sent.type }),
        },
        ...(sent === null ? {} : { body: sent.body }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw new ApiError(0, 'NETWORK', 'The request did not reach the server.', {}, cause);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new ApiError(0, 'NETWORK', 'The answer stopped before it was whole.', {}, cause);
    }
    if (!response.ok) throw refusal(response.status, text, response);
    return { status: response.status, text };
  };

  return {
    request: async <S extends TSchema>(
      method: Method,
      path: string,
      schema: S,
      options: RequestOptions = {},
    ): Promise<Static<S>> => {
      const { status, text } = await call(method, path, options);
      return answerOf(status, text, schema);
    },
    library: async (path: string, body: unknown): Promise<void> => {
      const deadline = new AbortController();
      const cancel = schedule(() => {
        deadline.abort();
      }, WRITE_DEADLINE_MS);
      try {
        await exchange('POST', path, { body }, deadline.signal, (status, text, response) =>
          libraryFailureOf(status, text, response.headers.get('retry-after')),
        );
      } catch (error) {
        // No answer at all is the network's, in the library's vocabulary too.
        if (error instanceof ApiError) throw new LibraryFailure(error.status, error.code);
        throw error;
      } finally {
        cancel();
      }
    },
    send: async (method: Method, path: string, options: RequestOptions = {}): Promise<void> => {
      await call(method, path, options);
    },
    upload: async <S extends TSchema>(
      path: string,
      schema: S,
      bytes: Blob,
      { query, onProgress }: UploadOptions,
    ): Promise<Static<S>> =>
      await new Promise<Static<S>>((resolve, reject) => {
        const request = newUpload();
        request.open('POST', withQuery(path, query));
        request.setRequestHeader('accept', 'application/json');
        request.setRequestHeader('content-type', 'application/octet-stream');
        request.upload.onprogress = (event): void => {
          if (event.lengthComputable) onProgress?.(event.loaded, event.total);
        };
        request.onload = (): void => {
          try {
            if (request.status < 200 || request.status > 299) {
              throw failureOf(request.status, request.responseText);
            }
            resolve(answerOf(request.status, request.responseText, schema));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        request.onerror = (): void => {
          reject(new ApiError(0, 'NETWORK', 'The request did not reach the server.'));
        };
        request.send(bytes);
      }),
  };
};
