/** Real HTTP/SQL remediation and content isolation. Native authentication capture has its own native-flow suite.
 * @needs-modules chat
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import {
  WorkspaceMfaEnrollment,
  WorkspaceMfaVerified,
  WorkspaceAccessPolicy,
  WorkspacePolicyRecovery,
  WorkspacePolicyTest,
  WorkspacePolicyPreview,
  MyWorkspaceMfa,
} from '@purlay/types/workspace-security';
import { hashPassword } from 'better-auth/crypto';
import { recordPrimaryAuthentication } from '../../modules/auth/authentication-evidence';
import { SESSION_COOKIE } from '../../platform/cookies';
import {
  aMovableClock,
  aRecordingLogger,
  testDependencies,
  testConfig,
} from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { codeAt, keyOf } from '../../testing/totp';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

afterAll(closeIntegrationDatabase);

describe('integration: workspace security HTTP', () => {
  test('policy and recovery route bindings preserve input, role and one-time proof contracts', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['policy-route-owner']);
      const owner = room.members['policy-route-owner'];
      if (owner === undefined) throw new Error('Missing policy route owner');
      const clock = aMovableClock(new Date());
      const session = await aSession(db, clock, owner.userId);
      await db
        .insertInto('accounts')
        .values({
          provider_id: 'credential',
          account_id: owner.userId,
          user_id: owner.userId,
          password: await hashPassword('Owning route fixture only 472!'),
        })
        .execute();
      await recordPrimaryAuthentication(db, session.sessionId, owner.userId, {
        method: 'password',
        authenticatedAt: clock.now(),
      });
      const app = createApp(
        testDependencies({
          database: db,
          auth: aTestAuth(db),
          clock,
          config: testConfig({ WORKSPACE_ACCESS_READY: true }),
        }),
      );
      const prefix = `/api/workspaces/${room.workspaceId}/security`;
      const request = async (path: string, method = 'GET', body?: unknown): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method,
            headers: {
              cookie: `${SESSION_COOKIE}=${session.token}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      for (const [method, suffix] of [
        ['POST', '/policy/preview'],
        ['POST', '/policy/test'],
        ['PUT', '/policy'],
        ['POST', '/recovery'],
        ['POST', '/recover'],
        ['POST', '/mfa/enrollment'],
        ['POST', '/mfa/challenges'],
        ['POST', '/mfa/verify'],
        ['POST', '/mfa/recovery'],
        ['DELETE', '/mfa'],
        ['POST', '/mfa/recovery-codes'],
      ] as const) {
        expect((await request(`${prefix}${suffix}`, method, {})).status).toBe(400);
      }
      expect(
        Value.Check(WorkspaceAccessPolicy, await (await request(`${prefix}/policy`)).json()),
      ).toBe(true);
      expect(Value.Check(MyWorkspaceMfa, await (await request(`${prefix}/mfa`)).json())).toBe(true);
      const recovery: unknown = await (
        await request(`${prefix}/recovery`, 'POST', { policyRevision: null })
      ).json();
      if (!Value.Check(WorkspacePolicyRecovery, recovery))
        throw new Error('Invalid owner recovery route response');
      const policy = {
        mode: 'enforced',
        signIn: 'any',
        allowedConnectionIds: [],
        requireMfa: false,
        idleMinutes: 15,
        maxAgeHours: 1,
        mfaMaxAgeMinutes: 5,
      };
      expect(
        Value.Check(
          WorkspacePolicyPreview,
          await (
            await request(`${prefix}/policy/preview`, 'POST', { revision: null, policy })
          ).json(),
        ),
      ).toBe(true);
      const tested: unknown = await (
        await request(`${prefix}/policy/test`, 'POST', { revision: null, policy })
      ).json();
      if (!Value.Check(WorkspacePolicyTest, tested))
        throw new Error('Invalid policy-test route response');
      const saved = await request(`${prefix}/policy`, 'PUT', {
        revision: null,
        policy,
        testId: tested.testId,
        testToken: tested.testToken,
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ epoch: '1', mode: 'enforced' });
      const recovered = await request(`${prefix}/recover`, 'POST', recovery);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ epoch: '2', mode: 'off' });
      expect((await request(`${prefix}/recover`, 'POST', recovery)).status).toBe(409);
    });
  });

  test('an owner can remove a governed member without borrowing the departing member’s session', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['offboarding-owner', 'offboarding-member']);
      const owner = room.members['offboarding-owner'];
      const departing = room.members['offboarding-member'];
      if (owner === undefined || departing === undefined)
        throw new Error('Missing offboarding actors');
      const clock = aMovableClock(new Date());
      const session = await aSession(db, clock, owner.userId);
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', room.workspaceId)
        .execute();
      await db
        .insertInto('workspace_access_policies')
        .values({
          workspace_id: room.workspaceId,
          epoch: '1',
          mode: 'off',
          sign_in: 'any',
          require_mfa: false,
        })
        .execute();
      const app = createApp(testDependencies({ database: db, auth: aTestAuth(db), clock }));
      const response = await app.handle(
        new Request(
          `https://purlay.test/api/workspaces/${room.workspaceId}/members/${departing.userId}`,
          {
            method: 'DELETE',
            headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
          },
        ),
      );
      expect(response.status).toBe(204);
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', departing.userId)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', owner.userId)
          .executeTakeFirst(),
      ).toBeDefined();
    });
  });

  test('blocked A directs only its member to remediation; B, own metadata and foreign 404s stay usable', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['policy-owner']);
      const owner = room.members['policy-owner'];
      if (owner === undefined) throw new Error('Missing fixture owner');
      const clock = aMovableClock(new Date());
      const session = await aSession(db, clock, owner.userId);
      const other = await db
        .insertInto('workspaces')
        .values({ name: 'Other workspace', slug: aUniqueSlug('other-policy') })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: other.id, user_id: owner.userId, role: 'owner' })
        .execute();
      const secret = await db
        .insertInto('channels')
        .values({ workspace_id: room.workspaceId, name: 'private-policy', type: 'private' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', room.workspaceId)
        .execute();
      await db
        .insertInto('workspace_access_policies')
        .values({
          workspace_id: room.workspaceId,
          epoch: '1',
          mode: 'enforced',
          sign_in: 'any',
          require_mfa: true,
        })
        .execute();
      const app = createApp(testDependencies({ database: db, auth: aTestAuth(db), clock }));
      const get = async (path: string): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
          }),
        );
      for (const path of [
        `/api/workspaces/${room.workspaceId}`,
        `/api/channels/${room.channelId}/messages`,
      ]) {
        const response = await get(path);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: 'WORKSPACE_ACCESS_REQUIRED', details: { workspaceId: room.workspaceId } },
        });
      }
      expect((await get(`/api/channels/${secret.id}/messages`)).status).toBe(404);
      expect((await get(`/api/workspaces/${crypto.randomUUID()}`)).status).toBe(404);
      expect((await get(`/api/workspaces/${other.id}`)).status).toBe(200);
      expect((await get('/api/me')).status).toBe(200);
      const workspace = await db
        .selectFrom('workspaces')
        .select('slug')
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow();
      const entry = await get(`/api/workspace-security?workspace=${workspace.slug}`);
      expect(entry.status).toBe(200);
      expect(await entry.json()).toMatchObject({
        workspaceId: room.workspaceId,
        role: 'owner',
        status: { state: 'sign_in_required' },
      });
      expect((await get('/api/workspace-security?workspace=not-my-workspace')).status).toBe(404);
      expect((await get(`/api/workspaces/${room.workspaceId}/security/policy`)).status).toBe(403);
    });
  });

  test('actual enrollment opens content, expired MFA alone permits a new code and successful foreground A refreshes idle', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['mfa-route-owner']);
      const owner = room.members['mfa-route-owner'];
      if (owner === undefined) throw new Error('Missing fixture owner');
      const clock = aMovableClock(new Date());
      const session = await aSession(db, clock, owner.userId);
      await recordPrimaryAuthentication(db, session.sessionId, owner.userId, {
        method: 'password',
        authenticatedAt: clock.now(),
      });
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', room.workspaceId)
        .execute();
      const policy = await db
        .insertInto('workspace_access_policies')
        .values({
          workspace_id: room.workspaceId,
          epoch: '1',
          mode: 'enforced',
          sign_in: 'any',
          require_mfa: true,
          idle_minutes: 15,
          max_age_hours: 1,
          mfa_max_age_minutes: 5,
        })
        .returning('revision')
        .executeTakeFirstOrThrow();
      const recording = aRecordingLogger();
      const app = createApp(
        testDependencies({ database: db, auth: aTestAuth(db), clock, log: recording.log }),
      );
      const request = async (
        path: string,
        method = 'GET',
        body?: unknown,
        active = false,
      ): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method,
            headers: {
              cookie: `${SESSION_COOKIE}=${session.token}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              ...(active ? { 'x-purlay-active-workspace': room.workspaceId } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const prefix = `/api/workspaces/${room.workspaceId}/security`;
      expect(await (await request(`${prefix}/access`)).json()).toMatchObject({
        state: 'mfa_enrollment_required',
      });
      const enrollment: unknown = await (
        await request(`${prefix}/mfa/enrollment`, 'POST', {
          policyRevision: policy.revision,
          factorRevision: null,
        })
      ).json();
      if (!Value.Check(WorkspaceMfaEnrollment, enrollment))
        throw new Error('Invalid enrollment response');
      const key = keyOf(enrollment.totpURI);
      const verification = await request(`${prefix}/mfa/verify`, 'POST', {
        challengeId: enrollment.challenge.challengeId,
        code: codeAt(key, clock.now().getTime()),
      });
      expect(verification.status).toBe(200);
      const verified: unknown = await verification.json();
      expect(Value.Check(WorkspaceMfaVerified, verified)).toBe(true);
      const content = `/api/channels/${room.channelId}/messages`;
      expect((await request(content)).status).toBe(200);
      clock.advance(2 * 60_000);
      expect((await request(content)).status).toBe(200);
      const invalid = await request(`${content}?limit=0`, 'GET', undefined, true);
      expect(invalid.status).toBe(400);
      await app.settled();
      const untouched = await db
        .selectFrom('workspace_session_assurances')
        .select('last_used_at')
        .where('workspace_id', '=', room.workspaceId)
        .where('session_id', '=', session.sessionId)
        .executeTakeFirstOrThrow();
      expect(new Date(untouched.last_used_at).getTime()).toBe(clock.now().getTime() - 2 * 60_000);
      const foreground = await request(content, 'GET', undefined, true);
      expect(foreground.status).toBe(200);
      await foreground.json();
      await app.settled();
      expect(recording.lines.filter((line) => line['purpose'] === 'workspace activity')).toEqual(
        [],
      );
      const current = await db
        .selectFrom('workspace_session_assurances')
        .select('last_used_at')
        .where('workspace_id', '=', room.workspaceId)
        .where('session_id', '=', session.sessionId)
        .executeTakeFirstOrThrow();
      expect(new Date(current.last_used_at)).toEqual(clock.now());
      clock.advance(4 * 60_000);
      expect((await request(content)).status).toBe(403);
      expect(await (await request(`${prefix}/access`)).json()).toMatchObject({
        state: 'mfa_required',
      });
      const challenge: unknown = await (
        await request(`${prefix}/mfa/challenges`, 'POST', {
          policyRevision: policy.revision,
          purpose: 'step_up',
          factorScope: 'workspace',
        })
      ).json();
      const { WorkspaceMfaChallenge } = await import('@purlay/types/workspace-security');
      if (!Value.Check(WorkspaceMfaChallenge, challenge))
        throw new Error('Invalid challenge response');
      expect(
        (
          await request(`${prefix}/mfa/verify`, 'POST', {
            challengeId: challenge.challengeId,
            code: codeAt(key, clock.now().getTime()),
          })
        ).status,
      ).toBe(200);
      expect((await request(content)).status).toBe(200);
    });
  });
});
