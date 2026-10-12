/**
 * `PUT /api/workspaces/:workspaceId/deep-work` through the HTTP surface (D-108): the contract's shape
 * both ways, the bound said by name, and `/api/me` saying until when.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { DeepWorkResponse, MeResponse } from '@purlay/types';
import { createApp } from './app';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const inAnHour = new Date(NOW.getTime() + 3_600_000).toISOString();

const call = async (
  db: Executor,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const aWorkspace = async (db: Executor): Promise<{ cookie: string; workspaceId: string }> => {
  const { cookie } = await aSignedInUser(db, clock, 'dw-alice');
  const created = await call(db, 'POST', '/api/workspaces', cookie, {
    name: 'dw',
    slug: aUniqueSlug('dw'),
  });
  return { cookie, workspaceId: ((await created.json()) as { id: string }).id };
};

describe('integration: Deep Work over HTTP', () => {
  test('started until an instant, said by /api/me, and ended', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const path = `/api/workspaces/${workspaceId}/deep-work`;
      const started = await call(db, 'PUT', path, cookie, { active: true, until: inAnHour });
      expect(started.status).toBe(200);
      const body: unknown = await started.json();
      expect(Value.Check(DeepWorkResponse, body)).toBe(true);
      expect(body).toEqual({ until: inAnHour });
      const me: unknown = await (await call(db, 'GET', '/api/me', cookie)).json();
      expect(Value.Check(MeResponse, me)).toBe(true);
      expect((me as MeResponse).memberships[0]?.deepWorkUntil).toBe(inAnHour);
      const ended = await call(db, 'PUT', path, cookie, { active: false });
      expect(await ended.json()).toEqual({ until: null });
    });
  });

  test('open-ended, in the past or past the bound is 400 by name; no session is 401', async () => {
    await withRollback(async (db) => {
      const { cookie, workspaceId } = await aWorkspace(db);
      const path = `/api/workspaces/${workspaceId}/deep-work`;
      for (const body of [
        { active: true },
        { active: true, until: NOW.toISOString() },
        { active: true, until: new Date(NOW.getTime() + 25 * 3_600_000).toISOString() },
      ]) {
        const refused = await call(db, 'PUT', path, cookie, body);
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          'VALIDATION_FAILED',
        );
      }
      expect((await call(db, 'PUT', path, undefined, { active: false })).status).toBe(401);
    });
  });
});
