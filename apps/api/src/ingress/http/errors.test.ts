/**
 * A client's mistake is never a 500 (#233).
 *
 * What the framework and the database report about a request that was wrong, and
 * what a client is told instead. The cause stays on this side of the boundary:
 * nothing a driver says about a constraint, a column or a value may reach the
 * response.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { ErrorResponse } from '@purlay/types';
import { createApp } from './app';
import { refusalFor } from './errors';
import { testDependencies } from './testing';

/** Shaped like the driver's `DatabaseError`, which is all `refusalFor` may rely on. */
const violation = (code: string, constraint?: string): Error =>
  Object.assign(new Error(`duplicate key value violates unique constraint "${constraint ?? ''}"`), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
    detail: 'Key (slug)=(secret-address) already exists.',
  });

const post = async (
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> =>
  await createApp(testDependencies()).handle(
    new Request(`https://purlay.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  );

describe('a request body that is not JSON', () => {
  test('is a 400 VALIDATION_FAILED, with or without a session, and does not echo the body', async () => {
    for (const headers of [{}, { cookie: '__Host-purlay_session=whatever' }]) {
      const response = await post('/api/workspaces', '{nope-secret', headers);
      expect(response.status).toBe(400);
      const text = await response.text();
      const body: unknown = JSON.parse(text);
      expect(Value.Check(ErrorResponse, body)).toBe(true);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect(text).not.toContain('nope-secret');
    }
  });
});

describe('what the database says about a request that was wrong', () => {
  test.each([
    ['workspaces_slug_key', 'WORKSPACE_SLUG_TAKEN'],
    ['idx_channels_unique_name', 'CHANNEL_NAME_TAKEN'],
    ['users_email_key', 'ACCOUNT_EMAIL_CONFLICT'],
    ['messages_pkey', 'MESSAGE_ID_CONFLICT'],
  ] as const)('a unique violation on %s is %s', (constraint, code) => {
    const refusal = refusalFor('UNKNOWN', violation('23505', constraint), []);
    expect(refusal.status).toBe(409);
    expect(refusal.body.error.code).toBe(code);
    expect(JSON.stringify(refusal.body)).not.toContain('secret-address');
  });

  test.each(['22001', '23514'])(
    'SQLSTATE %s is a validation failure that names nothing',
    (state) => {
      const refusal = refusalFor('UNKNOWN', violation(state, 'workspaces_name_check'), []);
      expect(refusal.status).toBe(400);
      expect(refusal.body.error.code).toBe('VALIDATION_FAILED');
      expect(Value.Check(ErrorResponse, refusal.body)).toBe(true);
      expect(JSON.stringify(refusal.body)).not.toContain('workspaces_name_check');
    },
  );

  test('a unique violation nobody mapped stays INTERNAL: it is a defect, not a mistake', () => {
    const refusal = refusalFor('UNKNOWN', violation('23505', 'sessions_token_hash_key'), []);
    expect(refusal.status).toBe(500);
    expect(refusal.body.error.code).toBe('INTERNAL');
  });

  test('other database failures stay INTERNAL', () => {
    expect(refusalFor('UNKNOWN', violation('40001'), []).status).toBe(500);
    expect(refusalFor('UNKNOWN', new Error('boom'), []).status).toBe(500);
  });
});
