/**
 * Managing members through the HTTP surface (`ARCHITECTURE.md` §7.4, I-2, #51): the answer read
 * against the contract, and each refusal with its status and code. The rules themselves are the
 * module's (`members.integration.test.ts`); who is told what is the realtime suite's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { AuditPage, WorkspaceMember } from '@purlay/types';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  who: SignedInUser,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        cookie: who.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const outcome = async (response: Response): Promise<string> =>
  response.ok
    ? String(response.status)
    : `${String(response.status)} ${((await response.json()) as { error: { code: string } }).error.code}`;

const aTeam = async (
  db: Executor,
): Promise<{ owner: SignedInUser; member: SignedInUser; workspaceId: string }> => {
  const owner = await aSignedInUser(db, clock, 'mm-owner');
  const member = await aSignedInUser(db, clock, 'mm-member');
  const slug = aUniqueSlug('mm');
  const created = await call(db, 'POST', '/api/workspaces', owner, { name: slug, slug });
  const workspaceId = ((await created.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: member.userId, role: 'member', joined_at: NOW })
    .execute();
  return { owner, member, workspaceId };
};

describe('integration: managing members over HTTP', () => {
  test('a role change answers the member as the contract has it; a member may not; a bad role is 400', async () => {
    await withRollback(async (db) => {
      const { owner, member, workspaceId } = await aTeam(db);
      const at = (userId: string): string => `/api/workspaces/${workspaceId}/members/${userId}`;
      const made = await call(db, 'PATCH', at(member.userId), owner, { role: 'admin' });
      expect(made.status).toBe(200);
      const body: unknown = await made.json();
      expect(Value.Check(WorkspaceMember, body)).toBe(true);
      expect(body).toMatchObject({ user: { id: member.userId }, role: 'admin' });

      await call(db, 'PATCH', at(member.userId), owner, { role: 'member' });
      expect(
        await outcome(await call(db, 'PATCH', at(owner.userId), member, { role: 'member' })),
      ).toBe('403 FORBIDDEN');
      expect(
        await outcome(await call(db, 'PATCH', at(member.userId), owner, { role: 'king' })),
      ).toBe('400 VALIDATION_FAILED');
    });
  });

  test('the last owner is 409; somebody not here is 404; a removal is 204 and they are gone', async () => {
    await withRollback(async (db) => {
      const { owner, member, workspaceId } = await aTeam(db);
      const at = (userId: string): string => `/api/workspaces/${workspaceId}/members/${userId}`;
      expect(
        await outcome(await call(db, 'PATCH', at(owner.userId), owner, { role: 'admin' })),
      ).toBe('409 LAST_OWNER');
      expect(await outcome(await call(db, 'DELETE', at(owner.userId), owner))).toBe(
        '409 LAST_OWNER',
      );
      const stranger = await aSignedInUser(db, clock, 'mm-stranger');
      expect(await outcome(await call(db, 'DELETE', at(stranger.userId), owner))).toBe(
        '404 USER_NOT_FOUND',
      );
      expect(await outcome(await call(db, 'DELETE', at(member.userId), owner))).toBe('204');
      expect(await outcome(await call(db, 'GET', `/api/workspaces/${workspaceId}`, member))).toBe(
        '404 WORKSPACE_NOT_FOUND',
      );
    });
  });

  test('the trail is read as the contract has it, by an owner; a member is refused', async () => {
    await withRollback(async (db) => {
      const { owner, member, workspaceId } = await aTeam(db);
      await call(db, 'PATCH', `/api/workspaces/${workspaceId}/members/${member.userId}`, owner, {
        role: 'admin',
      });
      const read = await call(db, 'GET', `/api/workspaces/${workspaceId}/audit?limit=10`, owner);
      expect(read.status).toBe(200);
      const page: unknown = await read.json();
      expect(Value.Check(AuditPage, page)).toBe(true);
      expect(page).toMatchObject({
        data: [{ action: 'member.role_changed', metadata: { from: 'member', to: 'admin' } }],
        nextCursor: null,
      });
      await call(db, 'PATCH', `/api/workspaces/${workspaceId}/members/${member.userId}`, owner, {
        role: 'member',
      });
      expect(
        await outcome(await call(db, 'GET', `/api/workspaces/${workspaceId}/audit`, member)),
      ).toBe('403 FORBIDDEN');
      expect(
        await outcome(await call(db, 'GET', `/api/workspaces/${workspaceId}/audit?limit=0`, owner)),
      ).toBe('400 VALIDATION_FAILED');
    });
  });
});
