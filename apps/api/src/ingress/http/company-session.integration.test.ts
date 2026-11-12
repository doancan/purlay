/** Company credentials cannot inherit global or unrelated workspace authority. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { AuthMethods, MeResponse, MembershipList } from '@purlay/types';
import { systemClock } from '../../platform/clock';
import { COMPANY_SESSION_COOKIE, readCookie } from '../../platform/cookies';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import { testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import {
  setupCompanyNative,
  companyNativeHeaders as headers,
  roundtripCompanyNative as roundtrip,
  enableCompanyNative as enable,
  signInCompanyNative,
} from '../../testing/company-native-auth';
import { aBrowser, KEYS } from '../../testing/push-service';
import { subscribe } from '../../modules/push/subscriptions';
import { atomicallyOn } from '../../platform/transactions';
import { createApp } from './app';
let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const setup = async (): Promise<Awaited<ReturnType<typeof setupCompanyNative>>> =>
  await setupCompanyNative(clone.db);
describe('integration: company session authority', () => {
  test('browser company logout clears its cookie and ends only that source session', async () => {
    const world = await signInCompanyNative(clone.db);
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    const response = await app.handle(
      new Request('https://purlay.test/auth/logout', {
        method: 'POST',
        headers: headers(world.cookie),
        body: '{}',
      }),
    );
    expect(response.status).toBe(204);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.startsWith(`${COMPANY_SESSION_COOKIE}=`) && cookie.includes('Max-Age=0'),
        ),
    ).toBe(true);
    expect(await sessionFromHeaders(world.auth, headers(world.cookie))).toBeUndefined();
    expect((await sessionFromHeaders(world.auth, headers(world.memberCookie)))?.userId).toBe(
      world.companySession.userId,
    );
  });

  test('the actual unsubscribe route carries its company source instead of deleting independent devices', async () => {
    const world = await signInCompanyNative(clone.db);
    const browser = await aBrowser();
    const own = `https://push.example.com/company-route/${world.companySession.sessionId}`;
    const independent = `https://push.example.com/independent-route/${world.fixture.member.sessionId}`;
    for (const [sessionId, endpoint] of [
      [world.companySession.sessionId, own],
      [world.fixture.member.sessionId, independent],
    ]) {
      if (sessionId === undefined || endpoint === undefined)
        throw new Error('Missing native device fixture');
      await atomicallyOn(clone.db)(async (transaction) => {
        await subscribe(
          transaction,
          systemClock,
          { userId: world.companySession.userId, sessionId },
          {
            endpoint,
            keys: { p256dh: browser.p256dh, auth: browser.auth },
            locale: 'en',
          },
          KEYS.publicKey,
        );
      });
    }
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    for (const endpoint of [independent, own]) {
      const response = await app.handle(
        new Request('https://purlay.test/api/push/subscriptions/remove', {
          method: 'POST',
          headers: headers(world.cookie),
          body: JSON.stringify({ endpoint }),
        }),
      );
      expect(response.status).toBe(204);
    }
    const kept = await clone.db
      .selectFrom('push_subscriptions')
      .select('endpoint')
      .where('user_id', '=', world.companySession.userId)
      .execute();
    expect(kept.map((row) => row.endpoint)).toEqual([independent]);
  });

  test('company sign-in grants only the issuing workspace, even for an existing server administrator', async () => {
    const configured = await setup();
    const { fixture, connection, auth } = configured;
    const enabled = await enable(configured);
    const other = await aRoom(clone.db, ['other-company-owner']);
    await clone.db
      .insertInto('workspace_members')
      .values({
        workspace_id: other.workspaceId,
        user_id: fixture.member.context.userId,
        role: 'admin',
      })
      .execute();
    await clone.db
      .updateTable('users')
      .set({ is_server_admin: true })
      .where('id', '=', fixture.member.context.userId)
      .execute();
    configured.idp.person = { sub: 'workspace-only-employee', email: 'employee@company.example' };
    expect(
      (
        await roundtrip(
          configured,
          {
            workspaceId: fixture.member.context.workspaceId,
            connectionId: connection.id,
            revision: enabled.revision,
            intent: 'link',
          },
          configured.memberCookie,
        )
      ).status,
    ).toBe(302);
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', fixture.member.context.workspaceId)
      .executeTakeFirstOrThrow();
    const signedIn = await roundtrip(
      configured,
      { workspace: workspace.slug, connectionId: connection.id },
      '',
      true,
    );
    expect(signedIn.status).toBe(302);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((line) => line.split(';')[0] ?? '')
      .join('; ');
    const app = createApp(testDependencies({ database: clone.db, auth, clock: systemClock }));
    const read = async (path: string, presented = cookie): Promise<Response> =>
      await app.handle(new Request(`https://purlay.test${path}`, { headers: headers(presented) }));
    expect((await read(`/api/workspaces/${fixture.member.context.workspaceId}`)).status).toBe(200);
    expect((await read(`/api/workspaces/${other.workspaceId}`)).status).toBe(404);
    expect((await read('/api/server/preferences')).status).toBe(404);
    expect((await read(`/api/channels/${other.channelId}/messages`)).status).toBe(404);
    const memberships: unknown = await (await read('/api/workspaces')).json();
    if (!Value.Check(MembershipList, memberships)) throw new Error('Invalid workspace list');
    expect(memberships.map((item) => item.workspace.id)).toEqual([
      fixture.member.context.workspaceId,
    ]);
    const me: unknown = await (await read('/api/me')).json();
    if (!Value.Check(MeResponse, me)) throw new Error('Invalid current person');
    expect(me.isServerAdmin).toBe(false);
    expect(me.mayCreateWorkspace).toBe(false);
    expect(me.companyWorkspaceId).toBe(fixture.member.context.workspaceId);
    expect(me.companySignInAvailable).toBe(true);
    expect(me.scheduledDeletions).toEqual([]);
    const methods: unknown = await (await read('/api/auth/methods')).json();
    if (!Value.Check(AuthMethods, methods)) throw new Error('Invalid company auth methods');
    expect(methods.company?.callbackUrl).toBe('https://purlay.test/auth/company/callback');
    const profile = await app.handle(
      new Request('https://purlay.test/api/me/profile', {
        method: 'PATCH',
        headers: headers(cookie),
        body: JSON.stringify({ title: 'Changed through company session' }),
      }),
    );
    expect(profile.status).toBe(403);
    expect(
      (
        await clone.db
          .selectFrom('users')
          .select('title')
          .where('id', '=', fixture.member.context.userId)
          .executeTakeFirstOrThrow()
      ).title,
    ).toBeNull();
    for (const path of ['/api/me/exports', '/api/me/sign-in', '/api/me/sessions'])
      expect((await read(path)).status).toBe(403);
    expect((await read('/auth/get-session')).status).toBe(200);
    // The product already hides account inventory; a native credential mutation is refused too.
    expect((await read('/auth/list-accounts')).status).toBe(404);
    expect(
      (
        await auth.handler(
          new Request('https://purlay.test/auth/change-password', {
            method: 'POST',
            headers: headers(cookie),
            body: JSON.stringify({
              currentPassword: 'unused',
              newPassword: 'independent-credential-123',
            }),
          }),
        )
      ).status,
    ).toBe(403);
    // A malformed company credential cannot fall back to a stronger independent credential.
    expect(
      (
        await read(
          `/api/workspaces/${other.workspaceId}`,
          `${configured.memberCookie}; ${COMPANY_SESSION_COOKIE}=tampered`,
        )
      ).status,
    ).toBe(401);
    const encodedCompany = readCookie(cookie, COMPANY_SESSION_COOKIE);
    if (encodedCompany === undefined) throw new Error('Missing company cookie');
    const decodedCompany = decodeURIComponent(encodedCompany);
    const signatureAt = decodedCompany.lastIndexOf('.') + 1;
    const corrupted =
      decodedCompany.slice(0, signatureAt) +
      (decodedCompany[signatureAt] === 'A' ? 'B' : 'A') +
      decodedCompany.slice(signatureAt + 1);
    expect(
      (
        await read(
          `/api/workspaces/${other.workspaceId}`,
          `${configured.memberCookie}; ${COMPANY_SESSION_COOKIE}=${encodeURIComponent(corrupted)}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await read(`/api/workspaces/${other.workspaceId}`, `${configured.memberCookie}; ${cookie}`))
        .status,
    ).toBe(404);
    // An independent session of the same person retains their separately established authority.
    expect(
      (await read(`/api/workspaces/${other.workspaceId}`, configured.memberCookie)).status,
    ).toBe(200);
    expect((await read('/api/server/preferences', configured.memberCookie)).status).toBe(200);
    const owner = await sessionFromHeaders(auth, headers(cookie));
    if (owner === undefined) throw new Error('Missing company session');
    // A hard provider purge cascades the proof, but must retain the session's restriction.
    await clone.db
      .deleteFrom('workspace_identity_connections')
      .where('id', '=', connection.id)
      .execute();
    expect(
      (
        await clone.db
          .selectFrom('sessions')
          .select('company_workspace_id')
          .where('id', '=', owner.sessionId)
          .executeTakeFirstOrThrow()
      ).company_workspace_id,
    ).toBe(fixture.member.context.workspaceId);
    expect(await sessionFromHeaders(auth, headers(cookie))).toBeUndefined();
    expect((await read(`/api/workspaces/${other.workspaceId}`)).status).toBe(401);
    expect(
      (await read(`/api/workspaces/${other.workspaceId}`, configured.memberCookie)).status,
    ).toBe(200);
  });
});
