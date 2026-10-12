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

/**
 * A query string as the schema reads it. Every parameter goes to the schema, so one it does not know
 * is refused by name rather than ignored; one given twice is refused, because the guard and the
 * schema would each read a different copy. Query strings are text: the parameters named in
 * `numbers` and `booleans` are converted, and anything but the words they expect is left as it came,
 * for the schema to refuse.
 */
export const queryOf = (
  url: URL,
  convert: { readonly numbers?: readonly string[]; readonly booleans?: readonly string[] } = {},
): Record<string, unknown> => {
  const repeated = [...url.searchParams.keys()].find((key, at, keys) => keys.indexOf(key) !== at);
  if (repeated !== undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Each parameter is given once.',
      details: { fields: { [repeated]: 'given more than once' } },
    });
  }
  const query: Record<string, unknown> = Object.fromEntries(url.searchParams);
  for (const key of convert.numbers ?? []) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = Number(value);
  }
  for (const key of convert.booleans ?? []) {
    const value = url.searchParams.get(key);
    if (value === 'true' || value === 'false') query[key] = value === 'true';
  }
  return query;
};
