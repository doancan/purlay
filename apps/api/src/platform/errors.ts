/**
 * The one error type the application throws.
 *
 * `ARCHITECTURE.md` §10: one `AppError` whose `code` is a discriminated union in
 * `@purlay/types`, never a free string — so a client handles it exhaustively and
 * adding a code breaks the switch that forgot it (D-47).
 *
 * The constructor takes the whole body rather than a code and a bag of extras.
 * That is what makes it total: `VALIDATION_FAILED` cannot be raised without its
 * `details`, and no other code can carry any — the union says so, so there is no
 * runtime branch to get wrong.
 *
 * The status is derived from the code, never passed in. Two call sites that
 * disagree about the status of the same code is a class of bug this removes
 * rather than tests for.
 */
import { statusFor, type AppErrorBody, type ErrorResponse, type HttpStatus } from '@purlay/types';

export class AppError extends Error {
  /** The wire body, exactly as the client receives it. */
  readonly body: AppErrorBody;
  readonly status: HttpStatus;
  /** How long the client should wait before asking again, sent as `Retry-After`; only with a 429. */
  readonly retryAfterSeconds: number | undefined;

  constructor(body: AppErrorBody, options: { readonly retryAfterSeconds?: number } = {}) {
    super(body.message);
    this.name = 'AppError';
    this.body = body;
    this.status = statusFor(body.code);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** The envelope. One shape, always. (`API.md` §1) */
  get response(): ErrorResponse {
    return { error: this.body };
  }
}

/** The one refusal for an attachment that is not there for the caller. */
export const attachmentNotFound = (): AppError =>
  new AppError({ code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found.' });

/**
 * The answer for a path nobody has, and so for a module's path that this process does not run and for one the workspace is not
 * granted (D-255 §2, D-289): one value, so the three cannot come to differ in a word.
 */
export const routeNotFound = (): AppError =>
  new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
