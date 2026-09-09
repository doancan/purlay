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

import { Type, type Static } from '@sinclair/typebox';

/** Statuses this API is allowed to return. (`API.md` §1) */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 500;

/**
 * `413` and `429` are in `API.md` §1's table and are **not** here: no code maps
 * to them yet, because uploads and the rate limiter are not built (#174). A
 * status this type permits but no code produces is a case a client is asked to
 * handle and will never see.
 */

/**
 * Every failure this API can express.
 *
 * **404, never 403, across a tenant or channel boundary.** A 403 confirms the
 * resource exists, which is itself a disclosure — so a request for something in
 * another workspace, or in a channel the caller cannot see, resolves to the
 * `*_NOT_FOUND` code for that resource. (D-21, D-34)
 */
export const ErrorCode = Type.Union([
  // Validation
  Type.Literal('VALIDATION_FAILED'),
  Type.Literal('INVALID_MESSAGE_ID'),
  // Authentication
  /**
   * Every reason a session does not resolve — absent, expired, revoked, or owned
   * by a deleted account — is this one code. There is deliberately no
   * `SESSION_EXPIRED`: telling them apart hands an unauthenticated caller an
   * oracle about accounts it does not own (D-60).
   */
  Type.Literal('UNAUTHENTICATED'),
  Type.Literal('OAUTH_STATE_INVALID'),
  Type.Literal('EMAIL_REQUIRED'),
  // Authorization — only ever for a resource the caller can already see
  Type.Literal('FORBIDDEN'),
  // Absence, and everything a boundary turns into absence
  /** No such route. Distinct from a resource that does not exist, or is not yours. */
  Type.Literal('ROUTE_NOT_FOUND'),
  Type.Literal('WORKSPACE_NOT_FOUND'),
  Type.Literal('CHANNEL_NOT_FOUND'),
  // Conflict
  /** A workspace slug is an identifier in a URL, so it is unique across the instance. */
  Type.Literal('WORKSPACE_SLUG_TAKEN'),
  Type.Literal('CHANNEL_NAME_TAKEN'),
  Type.Literal('MESSAGE_ID_CONFLICT'),
  Type.Literal('ACCOUNT_EMAIL_CONFLICT'),
  // Anything we failed to anticipate. Never carries detail to the client.
  Type.Literal('INTERNAL'),
]);
export type ErrorCode = Static<typeof ErrorCode>;

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

  FORBIDDEN: 403,
  EMAIL_REQUIRED: 403,

  ROUTE_NOT_FOUND: 404,
  WORKSPACE_NOT_FOUND: 404,
  CHANNEL_NOT_FOUND: 404,

  WORKSPACE_SLUG_TAKEN: 409,
  CHANNEL_NAME_TAKEN: 409,
  MESSAGE_ID_CONFLICT: 409,
  ACCOUNT_EMAIL_CONFLICT: 409,

  INTERNAL: 500,
};

/** Which field failed, and why, in language a person can act on. */
export const ValidationDetails = Type.Object({
  fields: Type.Record(Type.String(), Type.String()),
});
export type ValidationDetails = Static<typeof ValidationDetails>;

/**
 * The error body, discriminated on `code`.
 *
 * Only `VALIDATION_FAILED` carries details today, because it is the only code
 * `API.md` specifies details for. Others gain a member here when a real endpoint
 * needs one — a speculative payload is a shape nobody validates.
 */
export const AppErrorBody = Type.Union([
  Type.Object({
    code: Type.Literal('VALIDATION_FAILED'),
    message: Type.String(),
    details: ValidationDetails,
  }),
  Type.Object({
    // Derived, so the codes are listed once. A new code lands here automatically
    // rather than in a second list somebody has to remember to update.
    code: Type.Exclude(ErrorCode, Type.Literal('VALIDATION_FAILED')),
    message: Type.String(),
  }),
]);
export type AppErrorBody = Static<typeof AppErrorBody>;

/** The wire shape. One envelope, always. (`API.md` §1) */
export const ErrorResponse = Type.Object({ error: AppErrorBody });
export type ErrorResponse = Static<typeof ErrorResponse>;

/**
 * `MESSAGE_ID_CONFLICT` deliberately carries no detail: the response must not
 * confirm anything about the row it collided with, or a send becomes an
 * existence oracle. (D-33)
 */
export const statusFor = (code: ErrorCode): HttpStatus => ERROR_STATUS[code];
