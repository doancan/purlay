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
import { MESSAGE_GONE, goneMessageReference } from '../../platform/gone-message';
import type { AppErrorBody, ErrorResponse, HttpStatus } from '@purlay/types';
import { statusFor } from '@purlay/types';
import { DatabaseUnavailableError } from '@purlay/db';
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

/**
 * What the driver reports about a statement the database refused: the SQLSTATE
 * and, for a constraint, its name. Read by shape — this layer does not import the
 * driver — and only ever *into* a contract code; nothing the driver wrote
 * (the message, the detail, the offending value) is passed on.
 */
interface Violation {
  readonly sqlstate: string;
  readonly constraint: string | undefined;
}

const violationOf = (error: unknown): Violation | undefined => {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') {
    return undefined;
  }
  const constraint = 'constraint' in error ? error.constraint : undefined;
  return {
    sqlstate: error.code,
    constraint: typeof constraint === 'string' ? constraint : undefined,
  };
};

/**
 * The unique indexes that stand behind a code the contract already names. The
 * existence check in a service is a courtesy that races; the index is the
 * authority, and this is where losing the race becomes the same `409` the check
 * would have given (#233). A unique index not listed here is a defect, not a
 * client's mistake, and stays `INTERNAL`.
 */
const TAKEN_BY_INDEX: Readonly<Record<string, AppErrorBody>> = {
  // Two owners asking at once: the second finds the first's (D-140).
  idx_workspace_exports_one_pending: {
    code: 'EXPORT_IN_PROGRESS',
    message: 'An export of this workspace is being made already.',
  },
  workspaces_slug_key: {
    code: 'WORKSPACE_SLUG_TAKEN',
    message: 'That workspace address is already in use.',
  },
  idx_channels_unique_name: {
    code: 'CHANNEL_NAME_TAKEN',
    message: 'A channel with that name already exists here.',
  },
  users_email_key: {
    code: 'ACCOUNT_EMAIL_CONFLICT',
    message: 'That email address already belongs to another Purlay account.',
  },
  // Two accounts connecting one GitHub account at once: the second finds it the first's (D-172).
  users_github_id_key: {
    code: 'GITHUB_ACCOUNT_TAKEN',
    message: 'That GitHub account already signs in to another Purlay account.',
  },
  messages_pkey: {
    code: 'MESSAGE_ID_CONFLICT',
    message: 'That message id is already in use.',
  },
};

/** `unique_violation`, `string_data_right_truncation`, `check_violation`. */
const UNIQUE = '23505';
const TOO_LONG = '22001';
const CHECK = '23514';

/** The one mapping from a refused statement to a refusal, or `undefined` if it is not the client's doing. */
const refusalForViolation = ({ sqlstate, constraint }: Violation): AppErrorBody | undefined => {
  if (sqlstate === UNIQUE && constraint !== undefined) return TAKEN_BY_INDEX[constraint];
  if (sqlstate === TOO_LONG || sqlstate === CHECK) {
    // Which column, and which rule, is the schema's business. The client is told
    // the request was not acceptable, not how the table is built.
    return {
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the contract.',
      details: { fields: { body: 'is not acceptable' } },
    };
  }
  return undefined;
};

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

  // A message gone from under the write (D-139 §2): the same answer the socket gives.
  if (goneMessageReference(error) !== undefined) return respond(MESSAGE_GONE);

  if (error instanceof DatabaseUnavailableError) {
    return respond({
      code: 'DATABASE_UNAVAILABLE',
      message: 'The service is busy. Try again shortly.',
    });
  }

  if (code === 'VALIDATION') {
    return respond({
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the contract.',
      details: { fields: fieldsFrom(issues) },
    });
  }

  // A body that is not JSON never reaches a handler: the framework raises PARSE.
  // It is the client's mistake like any other, and its message quotes the body.
  if (code === 'PARSE') {
    return respond({
      code: 'VALIDATION_FAILED',
      message: 'The request body is not valid JSON.',
      details: { fields: { body: 'is not valid JSON' } },
    });
  }

  const violation = violationOf(error);
  const refused = violation === undefined ? undefined : refusalForViolation(violation);
  if (refused !== undefined) return respond(refused);

  if (code === 'NOT_FOUND') {
    return respond({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
  }

  return respond({ code: 'INTERNAL', message: 'Something went wrong.' });
};
