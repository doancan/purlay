/**
 * What went wrong with a request, in the closed vocabulary the contract defines.
 *
 * The API's `code` is a discriminated union (D-47), so a screen can handle every
 * case it knows and the compiler says when one is added. Two causes are the
 * client's own and have no server code, which is why they are named here and not
 * invented as strings at call sites:
 *
 * - `NETWORK` — no response at all (offline, refused, aborted by the page);
 * - `MALFORMED` — a response that is not what the contract says. A server frame
 *   or body that fails the schema is never trusted partially (D-82).
 */
import type { ErrorCode } from '@purlay/types';

export type ApiErrorCode = ErrorCode | 'NETWORK' | 'MALFORMED';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** The field messages of a `VALIDATION_FAILED`, keyed by field; empty for every other code. */
  readonly fields: Readonly<Record<string, string>>;
  /** The workspaces a refused erasure names, to hand over first (`LAST_OWNER`, D-139 §6); else none. */
  readonly workspaceIds: readonly string[];
  /** The room a workspace still has when a file did not fit (`STORAGE_QUOTA_EXCEEDED`, D-159); else null. */
  readonly remainingBytes: number | null;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    fields: Readonly<Record<string, string>> = {},
    cause?: unknown,
    workspaceIds: readonly string[] = [],
    remainingBytes: number | null = null,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.workspaceIds = workspaceIds;
    this.remainingBytes = remainingBytes;
  }
}

/** Narrowing for a caught value: a `catch` clause is `unknown`. */
export const isApiError = (value: unknown): value is ApiError => value instanceof ApiError;

/** True for a failure the person can do nothing about and a retry may fix. */
export const isTransient = (error: unknown): boolean =>
  isApiError(error) &&
  (error.code === 'NETWORK' ||
    error.code === 'DATABASE_UNAVAILABLE' ||
    error.code === 'RATE_LIMITED' ||
    error.code === 'INTERNAL');
