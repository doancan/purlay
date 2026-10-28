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
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 426 | 429 | 500 | 503;

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
  /**
   * An installed client whose contract or version is below what this server still serves, refused at
   * the edge before anything else is looked at (`API.md` §1 `426`, D-186). The body says what to get.
   */
  Type.Literal('CLIENT_TOO_OLD'),
  // Authentication
  /**
   * Every reason a session does not resolve — absent, expired, revoked, or owned
   * by a deleted account — is this one code. There is deliberately no
   * `SESSION_EXPIRED`: telling them apart hands an unauthenticated caller an
   * oracle about accounts it does not own (D-60).
   */
  Type.Literal('UNAUTHENTICATED'),
  /** A webhook delivery whose signature is missing, malformed, or not the feed's secret's (D-134 §4). */
  Type.Literal('WEBHOOK_SIGNATURE_INVALID'),
  // Authorization — only ever for a resource the caller can already see
  Type.Literal('FORBIDDEN'),
  /** The one irreversible act needs a sign-in from the last minutes, not an old session (D-139 §5). */
  Type.Literal('REAUTHENTICATION_REQUIRED'),
  /**
   * Writing in a channel the caller can see and is not in: a public channel they have not joined.
   * Joining it is the way on (D-156). Never for a channel they cannot see — that is its `404`.
   */
  Type.Literal('NOT_A_CHANNEL_MEMBER'),
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
  Type.Literal('SCHEDULED_MESSAGE_NOT_FOUND'),
  Type.Literal('SCHEDULED_MESSAGE_SENT'),
  Type.Literal('SCHEDULED_MESSAGE_LIMIT'),
  /** An earlier version of a message that is not there, or not this message's (D-135). */
  Type.Literal('MESSAGE_VERSION_NOT_FOUND'),
  /** An incident that is not there, or not this channel's (D-137). */
  Type.Literal('INCIDENT_NOT_FOUND'),
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
  /** A GitHub account another Purlay account already signs in with, found by the index on its id: never merged. */
  Type.Literal('GITHUB_ACCOUNT_TAKEN'),
  /** The channel already has a feed from this repository (D-134 §1). */
  Type.Literal('GITHUB_FEED_EXISTS'),
  /** Declaring an incident in a channel that has one open (D-137 §1). */
  Type.Literal('INCIDENT_OPEN'),
  /**
   * An incident id already used for another declaration — another channel's, or this one's at
   * another severity. A retry of the same declaration answers the incident instead (D-137 §5).
   */
  Type.Literal('INCIDENT_ID_CONFLICT'),
  /** A postmortem saved from a version another save has replaced (D-137 §5). */
  Type.Literal('INCIDENT_POSTMORTEM_CHANGED'),
  /** The incident already has as many responders as it may (D-137 §3). */
  Type.Literal('INCIDENT_RESPONDERS_LIMIT'),
  /** Changing an incident that is resolved: resolved is once and for good (D-137 §3). */
  Type.Literal('INCIDENT_RESOLVED'),
  /** A delivery from another repository than the feed's (D-134 §4). */
  Type.Literal('GITHUB_REPOSITORY_MISMATCH'),
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
  Type.Literal('SAVED_LIMIT'),
  /** The channel already has as many pins as it may (D-130). */
  Type.Literal('PINS_LIMIT'),
  /** The channel already hears from as many repositories as it may (D-134). */
  Type.Literal('GITHUB_FEEDS_LIMIT'),
  /**
   * An attachment id already used for another upload — somebody else's, another workspace's, or
   * the same person's with other bytes. A retry of the same upload answers the attachment instead.
   */
  Type.Literal('ATTACHMENT_ID_CONFLICT'),
  Type.Literal('ATTACHMENT_NOT_FOUND'),
  /** A session of the caller's that is not there to end: unknown, already ended, or somebody else's — one answer (D-193). */
  Type.Literal('SESSION_NOT_FOUND'),
  /** A link that does not open — unknown, expired, revoked, or its workspace gone: one answer (D-115). */
  Type.Literal('INVITATION_NOT_FOUND'),
  /** An export that is not there to download: unknown, not ready, downloaded already or expired (D-140). */
  Type.Literal('EXPORT_NOT_FOUND'),
  /** An export of the workspace is being made already: one at a time (D-140). */
  Type.Literal('EXPORT_IN_PROGRESS'),
  /** A sign-in link that does not open — unknown, used, expired: one answer (D-138 §4). */
  Type.Literal('SIGN_IN_LINK_NOT_FOUND'),
  /**
   * A native sign-in code that does not open — unknown, spent, expired, burnt, its person erased, or a wrong
   * verifier: one answer for all, so nothing says which (D-191).
   */
  Type.Literal('NATIVE_CODE_NOT_FOUND'),
  /** A repository's feed that does not exist, or is in a channel the caller cannot see (D-134). */
  Type.Literal('GITHUB_FEED_NOT_FOUND'),
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
   * No database connection could be had within the wait, or the process has not yet
   * read its settings from the database as it starts (D-179 §6): the server is busy,
   * not broken. The request changed nothing and may be retried. (D-87)
   */
  Type.Literal('DATABASE_UNAVAILABLE'),
  /**
   * The file store could not be reached, or none is configured: nothing was stored, and the request
   * may be retried. Never told as absence (D-109).
   */
  Type.Literal('STORAGE_UNAVAILABLE'),
  /** This server has no Web Push keys: push is switched off by its operator (#78). */
  Type.Literal('PUSH_UNAVAILABLE'),
  /** This server cannot send a sign-in link: no `SMTP_URL` and `MAIL_FROM` (D-138 §6). */
  Type.Literal('EMAIL_SIGN_IN_UNAVAILABLE'),
  // The setup in the browser (D-179 §4)
  /**
   * A `/setup` route to anybody but the browser holding the setup's claim: setup finished, never
   * claimed, claimed by another browser, a cookie wrong, idle or taken over — one answer, so nothing
   * tells them apart. Shaped as absence, as a route that does not exist is.
   */
  Type.Literal('SETUP_UNAVAILABLE'),
  /**
   * Five wrong setup codes locked every claim, the right code included, for fifteen minutes (the
   * server's lock, not a client's): `Retry-After` says how long is left; a restart, which writes a new
   * code, ends it.
   */
  Type.Literal('SETUP_LOCKED'),
  /** A step the browser holding the setup may not take now, and why (`SetupStepRefusal`). */
  Type.Literal('SETUP_STEP_REFUSED'),
  /**
   * A change of the server's settings did not complete (D-179 §4.9): at which stage, and whether only
   * a restart puts things right. Never what was in the change.
   */
  Type.Literal('SETTINGS_CHANGE_FAILED'),
  /**
   * A change of the server's settings the administrator may not make now, and why
   * (`ServerChangeRefusedDetails`): Administration → Server (D-179 §4.8).
   */
  Type.Literal('SERVER_CHANGE_REFUSED'),
  /**
   * The administrator's address link does not open — unknown, spent, expired, its account gone or its
   * address changed since: one answer (D-179 §4.3).
   */
  Type.Literal('ADMIN_LINK_NOT_FOUND'),
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

  UNAUTHENTICATED: 401,
  WEBHOOK_SIGNATURE_INVALID: 401,

  FORBIDDEN: 403,
  REAUTHENTICATION_REQUIRED: 403,
  NOT_A_CHANNEL_MEMBER: 403,

  ROUTE_NOT_FOUND: 404,
  WORKSPACE_NOT_FOUND: 404,
  CHANNEL_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  SCHEDULED_MESSAGE_NOT_FOUND: 404,
  SCHEDULED_MESSAGE_SENT: 409,
  SCHEDULED_MESSAGE_LIMIT: 409,
  MESSAGE_VERSION_NOT_FOUND: 404,
  INCIDENT_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,

  WORKSPACE_SLUG_TAKEN: 409,
  CHANNEL_NAME_TAKEN: 409,
  MESSAGE_ID_CONFLICT: 409,
  THREAD_NOT_RESOLVABLE: 409,
  ACCOUNT_EMAIL_CONFLICT: 409,
  GITHUB_ACCOUNT_TAKEN: 409,

  UNSUPPORTED_MEDIA_TYPE: 415,
  CLIENT_TOO_OLD: 426,

  PAYLOAD_TOO_LARGE: 413,
  LENGTH_REQUIRED: 411,
  IMAGE_UNREADABLE: 400,
  IMAGE_TOO_LARGE: 413,
  STORAGE_QUOTA_EXCEEDED: 413,
  TOO_MANY_PENDING_UPLOADS: 409,
  SAVED_LIMIT: 409,
  PINS_LIMIT: 409,
  GITHUB_FEEDS_LIMIT: 409,
  GITHUB_FEED_EXISTS: 409,
  INCIDENT_OPEN: 409,
  INCIDENT_ID_CONFLICT: 409,
  INCIDENT_RESOLVED: 409,
  INCIDENT_RESPONDERS_LIMIT: 409,
  INCIDENT_POSTMORTEM_CHANGED: 409,
  GITHUB_REPOSITORY_MISMATCH: 409,
  ATTACHMENT_ID_CONFLICT: 409,
  ATTACHMENT_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  INVITATION_NOT_FOUND: 404,
  EXPORT_NOT_FOUND: 404,
  EXPORT_IN_PROGRESS: 409,
  SIGN_IN_LINK_NOT_FOUND: 404,
  NATIVE_CODE_NOT_FOUND: 404,
  GITHUB_FEED_NOT_FOUND: 404,
  IMAGE_NOT_AVAILABLE: 404,
  LAST_OWNER: 409,
  LAST_CHANNEL_MEMBER: 409,
  RATE_LIMITED: 429,
  SETUP_UNAVAILABLE: 404,
  SETUP_LOCKED: 429,
  SETUP_STEP_REFUSED: 409,
  SETTINGS_CHANGE_FAILED: 500,
  SERVER_CHANGE_REFUSED: 409,
  ADMIN_LINK_NOT_FOUND: 404,

  INTERNAL: 500,
  STORAGE_UNAVAILABLE: 503,
  PUSH_UNAVAILABLE: 503,
  EMAIL_SIGN_IN_UNAVAILABLE: 503,
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
/**
 * The workspaces a refused erasure names: those the caller is the last live owner of, with somebody
 * else in them, to hand over first (D-139 §6). A role change refused for the same rule names none —
 * the workspace is the one in the path.
 */
export const LastOwnerDetails = Type.Object({
  workspaceIds: Type.Array(Type.String({ format: 'uuid' })),
});
export type LastOwnerDetails = Static<typeof LastOwnerDetails>;

/**
 * How much room the workspace still has, in bytes, when a file did not fit: what the quota leaves
 * after what is stored and what is waiting to be sent, so the person is told how large a file would
 * still go (D-159). The quota is the workspace's own number, and every member uploads into it.
 */
export const StorageQuotaDetails = Type.Object({
  remainingBytes: Type.Integer({ minimum: 0 }),
});
export type StorageQuotaDetails = Static<typeof StorageQuotaDetails>;

/** Why a setup step was refused (`SetupStepRefusal` in `setup.ts`, the same four). */
export const SetupStepRefusedDetails = Type.Object({
  reason: Type.Union([
    Type.Literal('out-of-order'),
    Type.Literal('no-workspace'),
    Type.Literal('no-channel'),
    Type.Literal('admin-exists'),
  ]),
});
export type SetupStepRefusedDetails = Static<typeof SetupStepRefusedDetails>;

/** Where a change of the settings stopped, and whether only a restart puts it right (D-179 §4.9). */
export const SettingsChangeFailedDetails = Type.Object({
  stage: Type.Union([
    Type.Literal('save'),
    Type.Literal('build'),
    Type.Literal('verify'),
    Type.Literal('commit'),
    Type.Literal('retire'),
  ]),
  restartNeeded: Type.Boolean(),
});
export type SettingsChangeFailedDetails = Static<typeof SettingsChangeFailedDetails>;

/**
 * Why Administration → Server refused a change (`409 SERVER_CHANGE_REFUSED`): `last-channel` — it would
 * leave the administrator's password as the only way in, and `confirmLastChannel` was not said;
 * `not-connected` — there is nothing of that kind to disconnect; `setup-unfinished` — the setup in the
 * browser is still open, and its steps are the way to change settings until it is finished.
 */
export const ServerChangeRefusedDetails = Type.Object({
  reason: Type.Union([
    Type.Literal('last-channel'),
    Type.Literal('not-connected'),
    Type.Literal('setup-unfinished'),
  ]),
});
export type ServerChangeRefusedDetails = Static<typeof ServerChangeRefusedDetails>;

/**
 * What a client too old to be served is told (`426 CLIENT_TOO_OLD`): the lowest contract and version the
 * server still serves — `null` for a limit the operator did not set — and where to get a newer one.
 */
export const ClientTooOldDetails = Type.Object({
  minContractVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  minAppVersion: Type.Union([Type.String(), Type.Null()]),
  downloadUrl: Type.Union([Type.String(), Type.Null()]),
});
export type ClientTooOldDetails = Static<typeof ClientTooOldDetails>;

export const AppErrorBody = Type.Union([
  Type.Object({
    code: Type.Literal('VALIDATION_FAILED'),
    message: Type.String(),
    details: ValidationDetails,
  }),
  Type.Object({
    code: Type.Literal('LAST_OWNER'),
    message: Type.String(),
    details: Type.Optional(LastOwnerDetails),
  }),
  Type.Object({
    code: Type.Literal('STORAGE_QUOTA_EXCEEDED'),
    message: Type.String(),
    details: Type.Optional(StorageQuotaDetails),
  }),
  Type.Object({
    code: Type.Literal('SETUP_STEP_REFUSED'),
    message: Type.String(),
    details: SetupStepRefusedDetails,
  }),
  Type.Object({
    code: Type.Literal('SETTINGS_CHANGE_FAILED'),
    message: Type.String(),
    details: SettingsChangeFailedDetails,
  }),
  Type.Object({
    code: Type.Literal('SERVER_CHANGE_REFUSED'),
    message: Type.String(),
    details: ServerChangeRefusedDetails,
  }),
  Type.Object({
    code: Type.Literal('CLIENT_TOO_OLD'),
    message: Type.String(),
    details: ClientTooOldDetails,
  }),
  Type.Object({
    // Derived, so the codes are listed once. A new code lands here automatically
    // rather than in a second list somebody has to remember to update.
    code: Type.Exclude(
      ErrorCode,
      Type.Union([
        Type.Literal('VALIDATION_FAILED'),
        Type.Literal('LAST_OWNER'),
        Type.Literal('STORAGE_QUOTA_EXCEEDED'),
        Type.Literal('SETUP_STEP_REFUSED'),
        Type.Literal('SETTINGS_CHANGE_FAILED'),
        Type.Literal('SERVER_CHANGE_REFUSED'),
        Type.Literal('CLIENT_TOO_OLD'),
      ]),
    ),
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
