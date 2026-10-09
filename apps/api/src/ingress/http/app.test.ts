/**
 * The HTTP surface, driven through real requests.
 *
 * `handle` takes a `Request` and returns a `Response`, so these exercise the
 * actual router and the actual error handler with no socket and no port — the
 * routing is not simulated, only the transport is absent.
 *
 * Three of these exist because a spike found the trap, not because it was
 * anticipated (`docs/spikes/elysia.md`).
 */
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ErrorResponse } from '@purlay/types';
import { DatabaseUnavailableError } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { createApp } from './app';
import { refusalFor } from './errors';
import { testDependencies } from './testing';

const get = async (path: string): Promise<Response> =>
  await createApp(testDependencies()).handle(new Request(`http://localhost${path}`));

const bodyOf = async (response: Response): Promise<unknown> => await response.json();

describe('the application', () => {
  /**
   * The database handle it is built with throws on any access, so this passing is
   * proof that liveness touches nothing — not an assertion that it did not.
   */
  test('answers liveness without touching the database', async () => {
    const response = await get('/health');
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ status: 'ok' });
  });

  test('an unknown route is the error envelope, not the framework default', async () => {
    const response = await get('/nope');
    expect(response.status).toBe(404);
    const body = await bodyOf(response);
    expect(Value.Check(ErrorResponse, body)).toBe(true);
    expect(body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' } });
  });
});

/**
 * A route that fails on purpose. Built here rather than added to the real
 * application: the surface must not carry an endpoint that exists only to be
 * tested.
 */
const withFailingRoutes = (): { handle: (request: Request) => Promise<Response> } =>
  new Elysia()
    .onError(({ code, error, set }) => {
      const issues = 'all' in error && Array.isArray(error.all) ? error.all : [];
      const refusal = refusalFor(code, error, issues);
      set.status = refusal.status;
      return refusal.body;
    })
    .get('/raises', () => {
      throw new AppError({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' });
    })
    .get('/breaks', () => {
      throw new Error('connection to 10.0.0.4:5432 refused for user purlay');
    })
    .post('/validated', ({ body }) => body, {
      body: Type.Object({ title: Type.String({ minLength: 3 }) }),
    });

const send = async (path: string, body?: unknown): Promise<Response> =>
  await withFailingRoutes().handle(
    new Request(`http://localhost${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
  );

describe('what a failure looks like from outside', () => {
  test('an AppError arrives as the status its code declares', async () => {
    const response = await send('/raises');
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({
      error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' },
    });
  });

  /**
   * The message thrown below names a host, a port, a user and a database. None
   * of it may cross the boundary — an unhandled failure says only that one
   * happened.
   */
  test('anything unrecognised is INTERNAL and discloses nothing', async () => {
    const response = await send('/breaks');
    expect(response.status).toBe(500);
    const text = JSON.stringify(await bodyOf(response));
    expect(JSON.parse(text)).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong.' },
    });
    for (const secret of ['10.0.0.4', '5432', 'purlay', 'refused', 'Error']) {
      expect(text).not.toContain(secret);
    }
  });

  /** Pool exhaustion is the server being busy, not broken: a 503 a client may retry, carrying no detail. */
  test('a pool with no connection to give is 503 and says nothing about why', () => {
    const refusal = refusalFor(
      'UNKNOWN',
      new DatabaseUnavailableError(new Error('timeout exceeded when trying to connect')),
      [],
    );
    expect(refusal.status).toBe(503);
    expect(refusal.body).toEqual({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The service is busy. Try again shortly.' },
    });
  });

  /**
   * The trap this was written against: `ValidationError` is not an `AppError`, so
   * a handler branching only on `instanceof AppError` sends every 422 to the
   * catch-all — a client that mistyped a field is told the server broke.
   */
  test('a validation failure is 400 with fields, not a 500', async () => {
    const response = await send('/validated', { title: 'no' });
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect(Value.Check(ErrorResponse, body)).toBe(true);
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  /**
   * The framework's own body echoes the request back and publishes the schema —
   * `found: {what you sent}` and `minLength` per issue. A typo would otherwise
   * come back as a description of the server's own rules.
   */
  test('and it returns neither the submitted value nor the schema', async () => {
    const response = await send('/validated', { title: 'no', secret: 'hunter2' });
    const text = JSON.stringify(await bodyOf(response));
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('minLength');
    expect(text).not.toContain('"found"');
  });
});
