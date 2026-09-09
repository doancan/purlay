/**
 * A request body, checked against the contract before anything reads it.
 *
 * Not the framework's own schema layer: its refusal **echoes the submitted value
 * back and publishes the schema** — `found: {what you sent}` and `minLength` per
 * issue — so a typo returns a description of the server's own rules
 * (`docs/spikes/elysia.md`). This produces the envelope `API.md` §1 specifies,
 * whose `details` name the fields and nothing else.
 *
 * `Value.Check` narrows, so nothing here needs a cast to believe the answer.
 */
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import { AppError } from '../../platform/errors';

export const validated = <T extends TSchema>(schema: T, body: unknown): Static<T> => {
  if (Value.Check(schema, body)) return body;

  const fields: Record<string, string> = {};
  for (const issue of Value.Errors(schema, body)) {
    const field = issue.path.replace(/^\//, '') || 'body';
    // The first problem per field. A list of every way one value is wrong is
    // noise to a person and a schema description to a prober.
    fields[field] ??= issue.message;
  }
  throw new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The request did not match the contract.',
    details: { fields },
  });
};
