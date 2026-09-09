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

  constructor(body: AppErrorBody) {
    super(body.message);
    this.name = 'AppError';
    this.body = body;
    this.status = statusFor(body.code);
  }

  /** The envelope. One shape, always. (`API.md` §1) */
  get response(): ErrorResponse {
    return { error: this.body };
  }
}
