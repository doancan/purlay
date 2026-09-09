/**
 * The error contract.
 *
 * `API.md` §1 enumerated HTTP statuses and left the machine-readable `code` as
 * free text. A free string cannot be handled exhaustively, and adding one breaks
 * nothing — which is how a client silently stops handling a case that now exists.
 * The set is closed here instead. (D-47)
 *
 * A code is added when the endpoint that raises it is built, not before.
 */

/** Statuses this API is allowed to return. (`API.md` §1) */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

/**
 * Every failure this API can express.
 *
 * **404, never 403, across a tenant or channel boundary.** A 403 confirms the
 * resource exists, which is itself a disclosure — so a request for something in
 * another workspace, or in a channel the caller cannot see, resolves to the
 * `*_NOT_FOUND` code for that resource. (D-21, D-34)
 */
export type ErrorCode =
  // Validation
  | 'VALIDATION_FAILED'
  | 'INVALID_MESSAGE_ID'
  // Authentication
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'OAUTH_STATE_INVALID'
  | 'EMAIL_REQUIRED'
  // Authorization — only ever for a resource the caller can already see
  | 'FORBIDDEN'
  // Absence, and everything a boundary turns into absence
  | 'WORKSPACE_NOT_FOUND'
  | 'CHANNEL_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'USER_NOT_FOUND'
  // Conflict
  | 'CHANNEL_NAME_TAKEN'
  | 'ALREADY_A_MEMBER'
  | 'MESSAGE_ID_CONFLICT'
  | 'ACCOUNT_EMAIL_CONFLICT'
  // Limits
  | 'RATE_LIMITED'
  // Anything we failed to anticipate. Never carries detail to the client.
  | 'INTERNAL';

/**
 * The status each code is returned with.
 *
 * `Record` makes this total: adding a code without deciding its status is a
 * compile error, so ingress never invents one at the call site.
 */
export const ERROR_STATUS: Record<ErrorCode, HttpStatus> = {
  VALIDATION_FAILED: 400,
  INVALID_MESSAGE_ID: 400,
  OAUTH_STATE_INVALID: 400,

  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,

  FORBIDDEN: 403,
  EMAIL_REQUIRED: 403,

  WORKSPACE_NOT_FOUND: 404,
  CHANNEL_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,

  CHANNEL_NAME_TAKEN: 409,
  ALREADY_A_MEMBER: 409,
  MESSAGE_ID_CONFLICT: 409,
  ACCOUNT_EMAIL_CONFLICT: 409,

  RATE_LIMITED: 429,

  INTERNAL: 500,
};

/** Which field failed, and why, in language a person can act on. */
export interface ValidationDetails {
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * The error body, discriminated on `code`.
 *
 * Only `VALIDATION_FAILED` carries details today, because it is the only code
 * `API.md` specifies details for. Others gain a member here when a real endpoint
 * needs one — a speculative payload is a shape nobody validates.
 */
export type AppErrorBody =
  | {
      readonly code: 'VALIDATION_FAILED';
      readonly message: string;
      readonly details: ValidationDetails;
    }
  | { readonly code: Exclude<ErrorCode, 'VALIDATION_FAILED'>; readonly message: string };

/** The wire shape. One envelope, always. (`API.md` §1) */
export interface ErrorResponse {
  readonly error: AppErrorBody;
}

/**
 * `MESSAGE_ID_CONFLICT` deliberately carries no detail: the response must not
 * confirm anything about the row it collided with, or a send becomes an
 * existence oracle. (D-33)
 */
export const statusFor = (code: ErrorCode): HttpStatus => ERROR_STATUS[code];
