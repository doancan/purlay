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
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 429 | 500 | 503;

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
  /** A request body that is not `application/json`. Refused before it is read. (D-80) */
  Type.Literal('UNSUPPORTED_MEDIA_TYPE'),
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
  /**
   * A message that does not exist, or is in a channel the caller cannot see. One
   * code for both, as the channel's is (D-34): which of the two it was is exactly
   * what the caller must not be able to learn.
   */
  Type.Literal('MESSAGE_NOT_FOUND'),
  /** A person who is not in the workspace — a direct message to a stranger, or to an erased account. */
  Type.Literal('USER_NOT_FOUND'),
  // Conflict
  /** A workspace slug is an identifier in a URL, so it is unique across the instance. */
  Type.Literal('WORKSPACE_SLUG_TAKEN'),
  Type.Literal('CHANNEL_NAME_TAKEN'),
  Type.Literal('MESSAGE_ID_CONFLICT'),
  /**
   * Resolving a message that cannot be resolved: a reply (only roots resolve), or a
   * root nobody has replied to (a resolved thread has at least one reply, I-8).
   */
  Type.Literal('THREAD_NOT_RESOLVABLE'),
  Type.Literal('ACCOUNT_EMAIL_CONFLICT'),
  // Volume
  /**
   * A body larger than the route takes, refused at the edge before it is read: 64 KiB for JSON
   * (`JSON_BODY_MAX_BYTES`), `ATTACHMENT_BYTES_MAX` for an upload (D-80, D-109 §4).
   */
  Type.Literal('PAYLOAD_TOO_LARGE'),
  /** A body with no `Content-Length`: its size cannot be judged before it is read (D-109 §4). */
  Type.Literal('LENGTH_REQUIRED'),
  /** An image whose pixels could not be read, though its first bytes said it was one (D-109 §1). */
  Type.Literal('IMAGE_UNREADABLE'),
  /** An image with more pixels, or a longer side, than an attachment may have (D-109 §2). */
  Type.Literal('IMAGE_TOO_LARGE'),
  /** The workspace's storage would pass its quota with this file (D-109 §5). */
  Type.Literal('STORAGE_QUOTA_EXCEEDED'),
  /** The person already holds as many unattached uploads here as they may (D-109 §5). */
  Type.Literal('TOO_MANY_PENDING_UPLOADS'),
  /**
   * An attachment id already used for another upload — somebody else's, another workspace's, or
   * the same person's with other bytes. A retry of the same upload answers the attachment instead.
   */
  Type.Literal('ATTACHMENT_ID_CONFLICT'),
  Type.Literal('ATTACHMENT_NOT_FOUND'),
  /** A link that does not open — unknown, expired, revoked, or its workspace gone: one answer (D-115). */
  Type.Literal('INVITATION_NOT_FOUND'),
  /** An external image the proxy will not or cannot show — one answer for every reason (#110). */
  Type.Literal('IMAGE_NOT_AVAILABLE'),
  Type.Literal('LAST_OWNER'),
  /**
   * Leaving a private channel nobody else is in: nobody could bring anyone back into it, so it is
   * refused rather than left unreachable. Bring somebody in first, or ask an admin to archive it (D-123).
   */
  Type.Literal('LAST_CHANNEL_MEMBER'),
  /**
   * Too many frames on one connection. The frame was not processed; sending it
   * again later is safe, because a message id makes a resend idempotent (D-8).
   */
  Type.Literal('RATE_LIMITED'),
  /**
   * No database connection could be had within the wait: the server is busy, not
   * broken. The request changed nothing and may be retried. (D-87)
   */
  Type.Literal('DATABASE_UNAVAILABLE'),
  /**
   * The file store could not be reached, or none is configured: nothing was stored, and the request
   * may be retried. Never told as absence (D-109).
   */
  Type.Literal('STORAGE_UNAVAILABLE'),
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
  MESSAGE_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,

  WORKSPACE_SLUG_TAKEN: 409,
  CHANNEL_NAME_TAKEN: 409,
  MESSAGE_ID_CONFLICT: 409,
  THREAD_NOT_RESOLVABLE: 409,
  ACCOUNT_EMAIL_CONFLICT: 409,

  UNSUPPORTED_MEDIA_TYPE: 415,

  PAYLOAD_TOO_LARGE: 413,
  LENGTH_REQUIRED: 411,
  IMAGE_UNREADABLE: 400,
  IMAGE_TOO_LARGE: 413,
  STORAGE_QUOTA_EXCEEDED: 413,
  TOO_MANY_PENDING_UPLOADS: 409,
  ATTACHMENT_ID_CONFLICT: 409,
  ATTACHMENT_NOT_FOUND: 404,
  INVITATION_NOT_FOUND: 404,
  IMAGE_NOT_AVAILABLE: 404,
  LAST_OWNER: 409,
  LAST_CHANNEL_MEMBER: 409,
  RATE_LIMITED: 429,

  INTERNAL: 500,
  STORAGE_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
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
