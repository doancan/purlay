/**
 * Every failure the API can emit, turned into a response. There is one of these.
 *
 * `ARCHITECTURE.md` §10: one `AppError`, never leak internals, never swallow.
 * The status comes from the code (`ERROR_STATUS`), so two handlers cannot
 * disagree about what a code means.
 *
 * **Three things here exist because a spike found them**, not because they were
 * anticipated (`docs/spikes/elysia.md`):
 *
 * 1. A framework validation failure is **not** an `AppError`. A handler written
 *    as `if (error instanceof AppError) … else 500` sends every 422 to the
 *    catch-all, so a client that posted a bad field is told the server broke.
 *    The `VALIDATION` branch below is that bug, closed before it was written.
 * 2. The framework's own validation body **echoes the request back** and
 *    **publishes the schema** — `found: {what you sent}` and `minLength` per
 *    issue. It is replaced entirely; `API.md` §1 says what goes out instead.
 * 3. Its `error.message` for a validation failure is the whole JSON blob as a
 *    string. Nothing here reads it.
 */
import type { AppErrorBody, ErrorResponse, HttpStatus } from '@purlay/types';
import { statusFor } from '@purlay/types';
import { AppError } from '../../platform/errors';

/** What a validation failure looks like coming out of the framework. */
interface FrameworkIssue {
  readonly path?: string;
  readonly summary?: string;
  readonly message?: string;
}

export interface Refusal {
  readonly status: HttpStatus;
  readonly body: ErrorResponse;
}

const respond = (body: AppErrorBody): Refusal => ({
  status: statusFor(body.code),
  body: { error: body },
});

/**
 * The field map `API.md` §1 promises, built from the framework's issue list.
 *
 * Only the path and the human-readable summary cross the boundary. The schema
 * and the submitted value stay on this side: publishing either turns a typo into
 * a description of the server's own rules.
 */
const fieldsFrom = (issues: readonly FrameworkIssue[]): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const field = (issue.path ?? '').replace(/^\//, '') || 'body';
    fields[field] ??= issue.summary ?? issue.message ?? 'is not valid';
  }
  return fields;
};

/**
 * The single mapping. Takes what the framework hands a global error hook and
 * decides what the client sees.
 *
 * `code` is the framework's own classification — a name, or a bare status number
 * for a route that set one; `error` is whatever was thrown.
 * Anything this function does not recognise becomes `INTERNAL` carrying nothing
 * — not the message, not the stack, not the database's opinion of the query.
 */
export const refusalFor = (
  code: string | number,
  error: unknown,
  issues: readonly FrameworkIssue[],
): Refusal => {
  if (error instanceof AppError) return respond(error.body);

  if (code === 'VALIDATION') {
    return respond({
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the contract.',
      details: { fields: fieldsFrom(issues) },
    });
  }

  if (code === 'NOT_FOUND') {
    return respond({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
  }

  return respond({ code: 'INTERNAL', message: 'Something went wrong.' });
};
