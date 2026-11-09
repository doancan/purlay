// What every endpoint file shares: how a path segment and a request's options are spelled.
import type { RequestOptions } from '../http';

export interface PageQuery {
  /** Older than this id (newest first). */
  readonly before?: string | undefined;
  /** Newer than this id (oldest first) — what a continuation after a reconnect asks for. */
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

/** What a request needs beyond its path: a body, a query, and the page's wish to abandon it. */
export const options = (extra: RequestOptions = {}, signal?: AbortSignal): RequestOptions => ({
  ...extra,
  ...(signal === undefined ? {} : { signal }),
});

/** An id as one path segment. */
export const at = (id: string): string => encodeURIComponent(id);
