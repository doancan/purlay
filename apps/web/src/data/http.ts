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
import { ApiError } from './errors';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** Appended as a query string; `undefined` values are left out. */
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
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
  /** For an endpoint whose answer is not read (a sign-out). */
  readonly send: (method: Method, path: string, options?: RequestOptions) => Promise<void>;
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

const failure = async (response: Response): Promise<ApiError> => {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return new ApiError(
      response.status,
      'MALFORMED',
      'The server answered with something unreadable.',
    );
  }
  const body: unknown =
    typeof parsed === 'object' && parsed !== null && 'error' in parsed ? parsed.error : undefined;
  if (!Value.Check(AppErrorBody, body)) {
    return new ApiError(
      response.status,
      'MALFORMED',
      'The server answered with something unreadable.',
    );
  }
  return new ApiError(
    response.status,
    body.code,
    body.message,
    body.code === 'VALIDATION_FAILED' ? body.details.fields : {},
  );
};

/** The part of `fetch` this client uses; the browser's satisfies it, and so does a test's. */
export type FetchPort = (input: string, init: RequestInit) => Promise<Response>;

export const createHttp = (fetchFn: FetchPort): Http => {
  const call = async (method: Method, path: string, options: RequestOptions): Promise<Response> => {
    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await fetchFn(withQuery(path, options.query), {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      throw new ApiError(0, 'NETWORK', 'The request did not reach the server.', {}, cause);
    }
    if (!response.ok) throw await failure(response);
    return response;
  };

  return {
    request: async <S extends TSchema>(
      method: Method,
      path: string,
      schema: S,
      options: RequestOptions = {},
    ): Promise<Static<S>> => {
      const response = await call(method, path, options);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new ApiError(
          response.status,
          'MALFORMED',
          'The server answered with something unreadable.',
        );
      }
      if (!Value.Check(schema, value)) {
        throw new ApiError(
          response.status,
          'MALFORMED',
          'The server answered with something the client does not understand.',
        );
      }
      return value;
    },
    send: async (method: Method, path: string, options: RequestOptions = {}): Promise<void> => {
      await call(method, path, options);
    },
  };
};
