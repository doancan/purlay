/** Actual pinned SCIM handlers, native hooks, SQL projections and company callback. @needs-modules chat */
import { createHash, hkdfSync } from 'node:crypto';
import { makeSignature } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { AUTH_BASE_PATH } from '@purlay/types';
import { systemClock } from '../../../platform/clock';
import { COMPANY_SESSION_COOKIE, SESSION_COOKIE } from '../../../platform/cookies';
import { PUSH_QUIET_BUS } from '../../../testing/pending-push';
import { aTestAuth, aSession, TEST_AUTH_SECRET } from '../../../testing/signed-in';
import {
  setupCompanyNative,
  enableCompanyNative,
  roundtripCompanyNative,
} from '../../../testing/company-native-auth';
import { noWorkspaceChannels, type WorkspaceChannels } from '../channels-port';
import { sessionFromHeaders } from '../../auth/sessions';
import { authorizeNative, exchangeNativeCode } from '../../auth/native-handoff';
import { companySessionCookies } from '../../auth/company-sessions';
import { lockWorkspaceProjectionScope } from '../provisioning/scope';
import { projectWorkspaceAccess } from '../provisioning/projection';
import {
  activeWorkspaceMembership,
  requireWorkspaceMembership,
  requireWorkspaceSecurityMembership,
} from '../../../platform/tenancy';
import { withinRequest } from '../../../platform/logging';
import {
  readWorkspaceContentPermits,
  type WorkspaceContentPermit,
} from '../../../platform/workspace-content-fence';
import { workspaceAccessStatus } from '../security/access';
import { NO_SESSION_LIFETIME } from '../../auth/session-lifetime';
import { unlinkCompanyIdentity } from '../identity/bindings';
import { listCompanyConnections, createCompanyConnection } from '../identity/connections';
import { OIDC_STUB_CREDENTIALS } from '../../../testing/oidc-stub';
import { AppError } from '../../../platform/errors';
import { blockWorkspaceAdmission } from '../provisioning/source-offboarding';
import { tokenDigest } from '../../../platform/tokens';
import { SCIM_CROSS_TENANT } from '../../../testing/cross-tenant';
import {
  createWorkspaceDirectory,
  updateWorkspaceDirectory,
  rotateDirectoryCredential,
  listWorkspaceDirectories,
  revokeDirectoryCredential,
  deleteWorkspaceDirectory,
} from './service';
import type { WorkspaceDirectoryDependencies } from './authority';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const setup = async (
  channels: WorkspaceChannels = noWorkspaceChannels,
  claim: 'sub' | 'oid' = 'sub',
): Promise<{
  readonly configured: Awaited<ReturnType<typeof setupCompanyNative>>;
  readonly dependencies: WorkspaceDirectoryDependencies;
  readonly directory: Awaited<ReturnType<typeof createWorkspaceDirectory>>;
  readonly token: string;
}> => {
  const original = await setupCompanyNative(clone.db);
  const bus = PUSH_QUIET_BUS;
  const dependencies: WorkspaceDirectoryDependencies = {
    ...original.fixture.dependencies,
    baseUrl: 'https://purlay.test',
    channels,
    bus,
    readersReady: () => Promise.resolve(true),
  };
  const auth = aTestAuth(clone.db, {
    clock: systemClock,
    companyIdentity: { cipher: original.fixture.dependencies.cipher, fetch: original.idp.fetch },
    directory: { channels, readersReady: dependencies.readersReady },
  });
  const configured = { ...original, auth };
  await enableCompanyNative(configured);
  let directory = await createWorkspaceDirectory(dependencies, configured.fixture.actor, {
    name: 'Company directory',
    connectionId: configured.connection.id,
    claim,
    allowCreate: true,
  });
  directory = await updateWorkspaceDirectory(dependencies, configured.fixture.actor, directory.id, {
    revision: directory.revision,
    enabled: true,
  });
  const issued = await rotateDirectoryCredential(
    dependencies,
    configured.fixture.actor,
    directory.id,
    { revision: directory.revision, expiresInDays: 30, overlapMinutes: 0 },
  );
  directory = issued.directory;
  return { configured, dependencies, directory, token: issued.token };
};
const call = async (
  f: Awaited<ReturnType<typeof setup>>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  await f.configured.auth.handler(
    new Request(`https://purlay.test${AUTH_BASE_PATH}/scim/v2/${path}`, {
      method,
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/scim+json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const user = (id: string, email = `${id}@company.example`): unknown => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  externalId: id,
  userName: email,
  displayName: 'Initial employee',
  active: true,
});
const resourceId = async (response: Response): Promise<string> => {
  const value: unknown = await response.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string'
  )
    throw new Error(`Missing actual SCIM resource ${String(response.status)}`);
  return value.id;
};

describe('integration: native directory provisioning', () => {
  test('creates a new employee through native admission then signs in by an exact active SCIM claim without a password or global email grant', async () => {
    const f = await setup();
    const external = crypto.randomUUID();
    const email = `employee-${external}@company.example`;
    const created = await call(f, 'POST', 'Users', user(external, email));
    expect(created.status).toBe(201);
    const id = await resourceId(created);
    const person = await clone.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    expect(person.email_verified).toBe(false);
    expect(person.admission_state).toBe('approved');
    expect(
      await clone.db.selectFrom('accounts').select('id').where('user_id', '=', person.id).execute(),
    ).toHaveLength(0);
    expect(
      await clone.db
        .selectFrom('workspace_directory_scim_subjects')
        .select('profile_source_id')
        .where('user_id', '=', person.id)
        .executeTakeFirst(),
    ).toEqual({ profile_source_id: null });
    const source = await clone.db
      .selectFrom('workspace_access_sources')
      .selectAll()
      .where('directory_id', '=', f.directory.id)
      .where('user_id', '=', person.id)
      .executeTakeFirstOrThrow();
    expect(source.directory_link_reference).toBe(id);
    expect(source.kind).toBe('directory');
    expect(source.builtin_role).toBe('member');
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', f.configured.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    f.configured.idp.person = { sub: external, email };
    const login = await roundtripCompanyNative(
      f.configured,
      { workspace: workspace.slug, connectionId: f.configured.connection.id },
      '',
      true,
    );
    expect(login.status).toBe(302);
    const cookie = login.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${COMPANY_SESSION_COOKIE}=`))
      ?.split(';')[0];
    expect(cookie).toBeDefined();
    const resolved = await sessionFromHeaders(
      f.configured.auth,
      new Headers({ cookie: cookie ?? '' }),
      { recordActivity: false },
    );
    expect(resolved?.userId).toBe(person.id);
    expect(
      (
        await clone.db
          .selectFrom('users')
          .select(['email_verified', 'display_name'])
          .where('id', '=', person.id)
          .executeTakeFirst()
      )?.email_verified,
    ).toBe(false);
    expect(
      await clone.db
        .selectFrom('session_authentication_evidence')
        .select(['method'])
        .where('session_id', '=', resolved?.sessionId ?? '')
        .executeTakeFirst(),
    ).toEqual({ method: 'company_oidc' });
    const proof = await clone.db
      .selectFrom('workspace_identity_sessions')
      .select(['directory_id', 'source_id', 'source_authorization_revision'])
      .where('session_id', '=', resolved?.sessionId ?? '')
      .executeTakeFirst();
    expect(proof).toEqual({
      directory_id: f.directory.id,
      source_id: source.id,
      source_authorization_revision: source.authorization_revision,
    });
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const grant = await authorizeNative(clone.db, systemClock, {
      userId: person.id,
      sourceSessionId: resolved?.sessionId ?? '',
      challenge,
    });
    const retained = await clone.db
      .selectFrom('native_authorizations')
      .select(['directory_id', 'code_digest'])
      .where('authentication_source_session_id', '=', resolved?.sessionId ?? '')
      .executeTakeFirstOrThrow();
    expect(retained.directory_id).toBe(f.directory.id);
    expect(retained.code_digest).not.toBe(
      await tokenDigest(`company-native-code@purlay/v1:${grant.code}`),
    );
    const handed = await exchangeNativeCode(
      clone.db,
      systemClock,
      { secret: TEST_AUTH_SECRET, sessionTtlDays: 30 },
      { code: grant.code, verifier },
    );
    expect(handed).toBeDefined();
    const handedCookie = await companySessionCookies(clone.db, TEST_AUTH_SECRET).nativeCookieValue(
      handed?.token ?? '',
    );
    expect(
      (
        await sessionFromHeaders(
          f.configured.auth,
          new Headers({ cookie: `${SESSION_COOKIE}=${handedCookie}` }),
          { recordActivity: false },
        )
      )?.userId,
    ).toBe(person.id);
    const originalEvidence = await clone.db
      .selectFrom('session_authentication_evidence')
      .select(['revision', 'method', 'authenticated_at'])
      .where('session_id', '=', resolved?.sessionId ?? '')
      .executeTakeFirstOrThrow();
    expect(
      await clone.db
        .selectFrom('session_authentication_evidence')
        .select(['revision', 'method', 'authenticated_at'])
        .where('session_id', '=', handed?.sessionId ?? '')
        .executeTakeFirst(),
    ).toEqual(originalEvidence);
    const encoded = decodeURIComponent(handedCookie);
    const dot = encoded.lastIndexOf('.');
    const rawToken = encoded.slice(0, dot);
    const oldSecret = Buffer.from(
      hkdfSync('sha256', TEST_AUTH_SECRET, '', 'company-session-cookie@purlay/v1', 32),
    ).toString('base64url');
    const legacyCookie = encodeURIComponent(
      `${rawToken}.${await makeSignature(rawToken, oldSecret)}`,
    );
    expect(
      await sessionFromHeaders(
        f.configured.auth,
        new Headers({ cookie: `${SESSION_COOKIE}=${legacyCookie}` }),
        { recordActivity: false },
      ),
    ).toBeUndefined();
    const outstanding = await authorizeNative(clone.db, systemClock, {
      userId: person.id,
      sourceSessionId: resolved?.sessionId ?? '',
      challenge,
    });
    const off = await call(f, 'PATCH', `Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(off.status).toBe(200);
    expect(
      await sessionFromHeaders(f.configured.auth, new Headers({ cookie: cookie ?? '' }), {
        recordActivity: false,
      }),
    ).toBeUndefined();
    expect(
      await sessionFromHeaders(
        f.configured.auth,
        new Headers({ cookie: `${SESSION_COOKIE}=${handedCookie}` }),
        { recordActivity: false },
      ),
    ).toBeUndefined();
    expect(
      await exchangeNativeCode(
        clone.db,
        systemClock,
        { secret: TEST_AUTH_SECRET, sessionTtlDays: 30 },
        { code: outstanding.code, verifier },
      ),
    ).toBeUndefined();
  });
  test('PUT/PATCH/DELETE and reprovision preserve the global profile, independent credentials/session and exact historical tombstone boundary', async () => {
    const f = await setup();
    const external = crypto.randomUUID();
    const email = `preserve-${external}@company.example`;
    const created = await call(f, 'POST', 'Users', user(external, email));
    expect(created.status).toBe(201);
    const id = await resourceId(created);
    const person = await clone.db
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'email_verified'])
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    const native = await f.configured.auth.$context;
    await native.internalAdapter.linkAccount({
      userId: person.id,
      providerId: 'credential',
      accountId: person.id,
      password: await native.password.hash('independent password 2026'),
    });
    const independent = await aSession(clone.db, systemClock, person.id);
    const before = await clone.db
      .selectFrom('accounts')
      .select(['id', 'password'])
      .where('user_id', '=', person.id)
      .execute();
    expect(
      (
        await call(f, 'PUT', `Users/${id}`, {
          ...(user(external, `changed-${external}@company.example`) as object),
          displayName: 'Provider renamed',
          roles: [{ value: 'owner' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(f, 'PATCH', `Users/${id}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'name.givenName', value: 'Changed' }],
        })
      ).status,
    ).toBe(200);
    expect((await call(f, 'DELETE', `Users/${id}`)).status).toBe(204);
    expect(
      await clone.db
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'email_verified'])
        .where('id', '=', person.id)
        .executeTakeFirst(),
    ).toEqual(person);
    expect(
      await clone.db
        .selectFrom('accounts')
        .select(['id', 'password'])
        .where('user_id', '=', person.id)
        .execute(),
    ).toEqual(before);
    expect(
      (
        await sessionFromHeaders(
          f.configured.auth,
          new Headers({ cookie: `${SESSION_COOKIE}=${independent.token}` }),
          { recordActivity: false },
        )
      )?.userId,
    ).toBe(person.id);
    const replacement = await call(f, 'POST', 'Users', user(external, email));
    expect(replacement.status).toBe(201);
    const replacementId = await resourceId(replacement);
    expect(replacementId).not.toBe(id);
    expect(
      (
        await clone.db
          .selectFrom('workspace_access_sources')
          .select('state')
          .where('directory_id', '=', f.directory.id)
          .where('directory_link_reference', '=', id)
          .executeTakeFirst()
      )?.state,
    ).toBe('retired');
    expect((await call(f, 'DELETE', `Users/${replacementId}`)).status).toBe(204);
    await clone.db
      .updateTable('workspace_directory_scim_tombstones')
      .set({ profile: 'manage' })
      .where('connection_id', '=', f.directory.id)
      .execute();
    const denied = await call(f, 'POST', 'Users', user(external, email));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '403',
    });
    expect(
      await clone.db
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'email_verified'])
        .where('id', '=', person.id)
        .executeTakeFirst(),
    ).toEqual(person);
    const signOut = await f.configured.auth.handler(
      new Request('https://purlay.test/auth/revoke-sessions', {
        method: 'POST',
        headers: {
          origin: 'https://purlay.test',
          cookie: `${SESSION_COOKIE}=${independent.token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(signOut.status).toBe(200);
    expect(
      await clone.db.selectFrom('sessions').select('id').where('user_id', '=', person.id).execute(),
    ).toHaveLength(0);
  });
  test('a reached native projection fault rolls back canonical initialization, identity link, SCIM resource and native source together', async () => {
    let fault = false;
    const channels: WorkspaceChannels = {
      ...noWorkspaceChannels,
      access: {
        ...noWorkspaceChannels.access,
        project: () => {
          if (fault) throw new Error('Reached directory projection fault');
          return Promise.resolve([]);
        },
        aggregateCapabilities: () => Promise.resolve(new Map()),
        countFor: () => Promise.resolve(0),
        roleUsers: () => Promise.resolve([]),
      },
    };
    const f = await setup(channels);
    const external = crypto.randomUUID();
    const email = `rollback-${external}@company.example`;
    fault = true;
    const failed = await call(f, 'POST', 'Users', user(external, email));
    expect(failed.status).toBe(500);
    expect(
      await clone.db.selectFrom('users').select('id').where('email', '=', email).execute(),
    ).toHaveLength(0);
    expect(
      await clone.db
        .selectFrom('workspace_directory_identity_links')
        .select('id')
        .where('directory_id', '=', f.directory.id)
        .execute(),
    ).toHaveLength(0);
    expect(
      await clone.db
        .selectFrom('workspace_directory_scim_users')
        .select('id')
        .where('connection_id', '=', f.directory.id)
        .execute(),
    ).toHaveLength(0);
    expect(
      await clone.db
        .selectFrom('workspace_access_sources')
        .select('id')
        .where('directory_id', '=', f.directory.id)
        .execute(),
    ).toHaveLength(0);
  });
  test('an A-only source revocation preserves manual A membership, a real B company session and independent native authority', async () => {
    const f = await setup();
    const external = crypto.randomUUID();
    const email = `sources-${external}@company.example`;
    const created = await call(f, 'POST', 'Users', user(external, email));
    expect(created.status).toBe(201);
    const resource = await resourceId(created);
    const person = await clone.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    const independent = await aSession(clone.db, systemClock, person.id);
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', f.configured.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    f.configured.idp.person = { sub: external, email };
    const login = await roundtripCompanyNative(
      f.configured,
      { workspace: workspace.slug, connectionId: f.configured.connection.id },
      '',
      true,
    );
    expect(login.status).toBe(302);
    let aCookie =
      login.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${COMPANY_SESSION_COOKIE}=`))
        ?.split(';')[0] ?? '';
    await clone.db.transaction().execute(async (tx) => {
      const scope = await lockWorkspaceProjectionScope(
        tx,
        f.configured.fixture.actor.context.workspaceId,
      );
      await tx
        .insertInto('workspace_access_sources')
        .values({
          workspace_id: scope.workspaceId,
          user_id: person.id,
          kind: 'manual',
          state: 'active',
          created_at: systemClock.now(),
          updated_at: systemClock.now(),
          builtin_role: 'member',
          access_kind: 'member',
          admitted_at: systemClock.now(),
        })
        .execute();
      await projectWorkspaceAccess(tx, systemClock, scope, [person.id], noWorkspaceChannels);
    });
    expect(
      (
        await sessionFromHeaders(f.configured.auth, new Headers({ cookie: aCookie }), {
          recordActivity: false,
        })
      )?.userId,
    ).toBe(person.id);
    const workspaceId = f.configured.fixture.actor.context.workspaceId;
    await clone.db
      .updateTable('workspaces')
      .set({ access_policy_epoch: '1' })
      .where('id', '=', workspaceId)
      .execute();
    await clone.db
      .insertInto('workspace_access_policies')
      .values({
        workspace_id: workspaceId,
        epoch: '1',
        mode: 'enforced',
        sign_in: 'any',
        require_mfa: false,
        idle_minutes: 15,
        max_age_hours: 1,
        mfa_max_age_minutes: 5,
      })
      .execute();
    const sourcePermit = async (
      sessionId: string,
      admit = true,
    ): Promise<WorkspaceContentPermit> => {
      if (admit)
        expect(
          (
            await workspaceAccessStatus(
              {
                database: clone.db,
                clock: systemClock,
                cipher: f.configured.fixture.dependencies.cipher,
                lifetime: (): typeof NO_SESSION_LIFETIME => NO_SESSION_LIFETIME,
              },
              {
                context: await requireWorkspaceSecurityMembership(clone.db, person.id, workspaceId),
                sessionId,
              },
            )
          ).state,
        ).toBe('allowed');
      const permit = (
        await readWorkspaceContentPermits(clone.db, {
          workspaceId,
          sessionIds: [sessionId],
          now: systemClock.now(),
          lifetime: NO_SESSION_LIFETIME,
        })
      ).get(sessionId);
      if (permit === undefined) throw new Error('Missing real directory content permit');
      return permit;
    };
    const capturedRows = async (
      permit: WorkspaceContentPermit,
      sessionId: string,
    ): Promise<number> =>
      await withinRequest(
        { requestId: 'captured-directory-fence', startedAt: 0, sessionId },
        async () => {
          permit.capture(systemClock.now());
          return (
            await clone.db
              .selectFrom('workspaces')
              .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
              .select('workspaces.id')
              .where('workspaces.id', '=', workspaceId)
              .where('workspace_members.user_id', '=', person.id)
              .where(activeWorkspaceMembership())
              .execute()
          ).length;
        },
      );
    const oldA = await sessionFromHeaders(f.configured.auth, new Headers({ cookie: aCookie }), {
      recordActivity: false,
    });
    if (oldA === undefined) throw new Error('Missing actual directory-A session');
    const oldPermit = await sourcePermit(oldA.sessionId);
    expect(oldPermit.decision.allowed).toBe(true);
    expect(await capturedRows(oldPermit, oldA.sessionId)).toBe(1);
    const b = await setupCompanyNative(clone.db);
    await clone.db
      .insertInto('workspace_members')
      .values({
        workspace_id: b.fixture.actor.context.workspaceId,
        user_id: person.id,
        role: 'member',
      })
      .execute();
    const bConnection = await enableCompanyNative(b);
    b.idp.person = { sub: 'b-' + external, email };
    expect(
      (
        await roundtripCompanyNative(
          b,
          {
            workspaceId: b.fixture.actor.context.workspaceId,
            connectionId: b.connection.id,
            revision: bConnection.revision,
            intent: 'link',
          },
          `${SESSION_COOKIE}=${independent.token}`,
        )
      ).status,
    ).toBe(302);
    const bWorkspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', b.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    const bLogin = await roundtripCompanyNative(
      b,
      { workspace: bWorkspace.slug, connectionId: b.connection.id },
      '',
      true,
    );
    expect(bLogin.status).toBe(302);
    const bCookie =
      bLogin.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${COMPANY_SESSION_COOKIE}=`))
        ?.split(';')[0] ?? '';
    await clone.db.transaction().execute(async (tx) => {
      await lockWorkspaceProjectionScope(tx, f.configured.fixture.actor.context.workspaceId);
      await tx
        .updateTable('workspace_access_sources')
        .set({
          authorization_revision: crypto.randomUUID(),
          revision: crypto.randomUUID(),
          updated_at: systemClock.now(),
        })
        .where('directory_id', '=', f.directory.id)
        .where('directory_link_reference', '=', resource)
        .execute();
    });
    expect(
      await sessionFromHeaders(f.configured.auth, new Headers({ cookie: aCookie }), {
        recordActivity: false,
      }),
    ).toBeUndefined();
    expect(await capturedRows(oldPermit, oldA.sessionId)).toBe(0);
    expect((await sourcePermit(oldA.sessionId, false)).decision.allowed).toBe(false);
    const renewed = await roundtripCompanyNative(
      f.configured,
      { workspace: workspace.slug, connectionId: f.configured.connection.id },
      '',
      true,
    );
    expect(renewed.status).toBe(302);
    aCookie =
      renewed.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${COMPANY_SESSION_COOKIE}=`))
        ?.split(';')[0] ?? '';
    const freshA = await sessionFromHeaders(f.configured.auth, new Headers({ cookie: aCookie }), {
      recordActivity: false,
    });
    if (freshA === undefined) throw new Error('Missing fresh directory-A session');
    const freshPermit = await sourcePermit(freshA.sessionId);
    expect(freshPermit.decision.allowed).toBe(true);
    expect(await capturedRows(freshPermit, freshA.sessionId)).toBe(1);
    expect(
      (
        await call(f, 'PATCH', `Users/${resource}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        })
      ).status,
    ).toBe(200);
    expect(
      await sessionFromHeaders(f.configured.auth, new Headers({ cookie: aCookie }), {
        recordActivity: false,
      }),
    ).toBeUndefined();
    expect(await capturedRows(freshPermit, freshA.sessionId)).toBe(0);
    expect((await sourcePermit(freshA.sessionId, false)).decision.allowed).toBe(false);
    expect(
      (
        await sessionFromHeaders(f.configured.auth, new Headers({ cookie: bCookie }), {
          recordActivity: false,
        })
      )?.companyWorkspaceId,
    ).toBe(b.fixture.actor.context.workspaceId);
    expect(
      (
        await sessionFromHeaders(
          f.configured.auth,
          new Headers({ cookie: `${SESSION_COOKIE}=${independent.token}` }),
          { recordActivity: false },
        )
      )?.userId,
    ).toBe(person.id);
    expect(
      await clone.db
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', f.configured.fixture.actor.context.workspaceId)
        .where('user_id', '=', person.id)
        .execute(),
    ).toHaveLength(1);
  });

  test('unlink and native-session purge cannot replay first-company-binding initialization; explicit native user relinking can authorize a new binding', async () => {
    const f = await setup();
    const external = crypto.randomUUID();
    const email = `unlink-${external}@company.example`;
    const created = await call(f, 'POST', 'Users', user(external, email));
    expect(created.status).toBe(201);
    const person = await clone.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', f.configured.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    f.configured.idp.person = { sub: external, email };
    const body = { workspace: workspace.slug, connectionId: f.configured.connection.id };
    expect((await roundtripCompanyNative(f.configured, body, '', true)).status).toBe(302);
    const binding = await clone.db
      .selectFrom('workspace_identity_bindings')
      .select('id')
      .where('connection_id', '=', f.configured.connection.id)
      .where('user_id', '=', person.id)
      .executeTakeFirstOrThrow();
    const independent = await aSession(clone.db, systemClock, person.id);
    const context = await requireWorkspaceMembership(
      clone.db,
      person.id,
      f.configured.fixture.actor.context.workspaceId,
    );
    await unlinkCompanyIdentity(
      f.configured.fixture.dependencies,
      { context, sessionId: independent.sessionId },
      f.configured.connection.id,
      binding.id,
    );
    await clone.db
      .deleteFrom('sessions')
      .where('user_id', '=', person.id)
      .where('company_workspace_id', '=', context.workspaceId)
      .execute();
    expect(
      await clone.db
        .selectFrom('workspace_directory_native_initializations')
        .select('binding_reference')
        .where('binding_reference', '=', binding.id)
        .execute(),
    ).toHaveLength(1);
    expect((await roundtripCompanyNative(f.configured, body, '', true)).status).toBe(409);
    const connection = (
      await listCompanyConnections(f.configured.fixture.dependencies, f.configured.fixture.actor)
    ).data.find((row) => row.id === f.configured.connection.id);
    if (connection === undefined) throw new Error('Missing native connection');
    expect(
      (
        await roundtripCompanyNative(
          f.configured,
          {
            workspaceId: context.workspaceId,
            connectionId: connection.id,
            revision: connection.revision,
            intent: 'link',
          },
          `${SESSION_COOKIE}=${independent.token}`,
        )
      ).status,
    ).toBe(302);
    expect((await roundtripCompanyNative(f.configured, body, '', true)).status).toBe(302);
  });

  test('native SCIM Groups project exact directory groups and source membership, and an invalid name rolls the native resource back', async () => {
    const f = await setup();
    const external = crypto.randomUUID();
    const personResponse = await call(f, 'POST', 'Users', user(external));
    expect(personResponse.status).toBe(201);
    const personResource = await resourceId(personResponse);
    const source = await clone.db
      .selectFrom('workspace_access_sources')
      .select('id')
      .where('directory_id', '=', f.directory.id)
      .where('directory_link_reference', '=', personResource)
      .executeTakeFirstOrThrow();
    const created = await call(f, 'POST', 'Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Finance',
      externalId: 'finance',
      members: [{ value: personResource }],
    });
    expect(created.status).toBe(201);
    const nativeId = await resourceId(created);
    const group = await clone.db
      .selectFrom('workspace_access_groups')
      .select(['id', 'kind', 'name', 'directory_id'])
      .where('directory_group_reference', '=', nativeId)
      .executeTakeFirstOrThrow();
    expect(group).toMatchObject({
      kind: 'directory',
      name: 'Finance',
      directory_id: f.directory.id,
    });
    expect(
      await clone.db
        .selectFrom('workspace_access_group_members')
        .select('source_id')
        .where('group_id', '=', group.id)
        .execute(),
    ).toEqual([{ source_id: source.id }]);
    expect(
      (
        await call(f, 'PATCH', `Groups/${nativeId}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            { op: 'replace', path: 'displayName', value: 'Accounts' },
            { op: 'replace', path: 'members', value: [] },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      await clone.db
        .selectFrom('workspace_access_group_members')
        .select('source_id')
        .where('group_id', '=', group.id)
        .execute(),
    ).toHaveLength(0);
    expect(
      (
        await clone.db
          .selectFrom('workspace_access_groups')
          .select('name')
          .where('id', '=', group.id)
          .executeTakeFirst()
      )?.name,
    ).toBe('Accounts');
    const invalid = await call(f, 'POST', 'Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'x'.repeat(65),
      members: [],
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { scimType: string }).scimType).toBe('invalidValue');
    expect(invalid.headers.get('content-type')).toContain('application/scim+json');
    expect(
      await clone.db
        .selectFrom('workspace_directory_scim_groups')
        .select('id')
        .where('connection_id', '=', f.directory.id)
        .where('display_name', '=', 'x'.repeat(65))
        .execute(),
    ).toHaveLength(0);
    expect((await call(f, 'DELETE', `Groups/${nativeId}`)).status).toBe(204);
    expect(
      (
        await clone.db
          .selectFrom('workspace_access_groups')
          .select('state')
          .where('id', '=', group.id)
          .executeTakeFirst()
      )?.state,
    ).toBe('retired');
    const missing = await call(f, 'GET', `Groups/${nativeId}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/scim+json');
  });

  test('directory initialization preserves global account approval and allowed-domain admission', async () => {
    const f = await setup();
    const old = await clone.db
      .selectFrom('server_settings')
      .select(['allowed_email_domains', 'require_account_approval'])
      .where('id', '=', true)
      .executeTakeFirst();
    try {
      await clone.db
        .insertInto('server_settings')
        .values({
          id: true,
          require_account_approval: true,
          allowed_email_domains: ['company.example'],
        })
        .onConflict((c) =>
          c.column('id').doUpdateSet({
            require_account_approval: true,
            allowed_email_domains: ['company.example'],
          }),
        )
        .execute();
      const external = crypto.randomUUID();
      const email = `pending-${external}@company.example`;
      expect((await call(f, 'POST', 'Users', user(external, email))).status).toBe(201);
      const person = await clone.db
        .selectFrom('users')
        .select(['id', 'admission_state', 'email_verified', 'admission_requires_verified_email'])
        .where('email', '=', email)
        .executeTakeFirstOrThrow();
      expect(person.admission_state).toBe('pending');
      expect(person.email_verified).toBe(false);
      expect(person.admission_requires_verified_email).toBe(true);
      const foreign = crypto.randomUUID();
      expect(
        (await call(f, 'POST', 'Users', user(foreign, `${foreign}@outside.example`))).status,
      ).toBe(403);
      expect(
        await clone.db
          .selectFrom('workspace_directory_identity_links')
          .select('id')
          .where('directory_id', '=', f.directory.id)
          .where('external_id', '=', foreign)
          .execute(),
      ).toHaveLength(0);
    } finally {
      if (old === undefined)
        await clone.db.deleteFrom('server_settings').where('id', '=', true).execute();
      else await clone.db.updateTable('server_settings').set(old).where('id', '=', true).execute();
    }
  });

  test('directory callbacks cannot consume inactive global-delete authority and delayed children remain revoked', async () => {
    let attack = false;
    const hooks: { globalDelete?: (userId: string) => Promise<void> } = {};
    let immediate: unknown;
    let delayed: Promise<unknown> | undefined;
    const released = Promise.withResolvers<undefined>();
    const channels: WorkspaceChannels = {
      ...noWorkspaceChannels,
      access: {
        project: async (_tx, _clock, _scope, userIds) => {
          const userId = userIds[0];
          if (attack && userId !== undefined && hooks.globalDelete !== undefined) {
            const invoke = hooks.globalDelete;
            immediate = await invoke(userId).catch((error: unknown) => error);
            delayed = (async (): Promise<unknown> => {
              await released.promise;
              return await invoke(userId).catch((error: unknown) => error);
            })();
          }
          return [];
        },
        aggregateCapabilities: () => Promise.resolve(new Map()),
        countFor: () => Promise.resolve(0),
        roleUsers: () => Promise.resolve([]),
      },
    };
    const f = await setup(channels);
    const external = crypto.randomUUID();
    const created = await call(f, 'POST', 'Users', user(external));
    expect(created.status).toBe(201);
    const id = await resourceId(created);
    const linked = await clone.db
      .selectFrom('workspace_directory_scim_users')
      .select('user_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const independent = await aSession(clone.db, systemClock, linked.user_id);
    const native = await f.configured.auth.$context;
    hooks.globalDelete = async (userId): Promise<void> => {
      await native.internalAdapter.deleteUserSessions(userId);
    };
    attack = true;
    try {
      expect(
        (
          await call(f, 'PATCH', `Users/${id}`, {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value: false }],
          })
        ).status,
      ).toBe(200);
      expect(immediate).toBeInstanceOf(Error);
    } finally {
      released.resolve(undefined);
    }
    expect(await delayed).toBeInstanceOf(Error);
    expect(
      (
        await sessionFromHeaders(
          f.configured.auth,
          new Headers({ cookie: `${SESSION_COOKIE}=${independent.token}` }),
          { recordActivity: false },
        )
      )?.userId,
    ).toBe(linked.user_id);
  });

  test('credential revisions, one-way rotation, bounded history and missing readiness are enforced by actual token verification', async () => {
    const f = await setup();
    const empty = await listWorkspaceDirectories(f.dependencies, f.configured.fixture.actor, {
      limit: 1,
    });
    expect(empty.data[0]?.id).toBe(f.directory.id);
    const rotated = await rotateDirectoryCredential(
      f.dependencies,
      f.configured.fixture.actor,
      f.directory.id,
      { revision: f.directory.revision, expiresInDays: 1, overlapMinutes: 0 },
    );
    expect(rotated.directory.credentials.some((c) => c.revokedAt !== null)).toBe(true);
    expect((await call(f, 'GET', 'Users')).status).toBe(401);
    const revoked = await revokeDirectoryCredential(
      f.dependencies,
      f.configured.fixture.actor,
      f.directory.id,
      { revision: rotated.directory.revision, credentialId: rotated.credential.id },
    );
    expect(revoked.credentials.every((c) => c.revokedAt !== null)).toBe(true);
    expect(
      JSON.stringify(await listWorkspaceDirectories(f.dependencies, f.configured.fixture.actor)),
    ).not.toContain(rotated.token);
    const unready = aTestAuth(clone.db, {
      directory: { channels: noWorkspaceChannels, readersReady: () => Promise.resolve(false) },
    });
    expect(
      (
        await unready.handler(
          new Request('https://purlay.test/auth/scim/v2/Users', {
            headers: { authorization: `Bearer ${rotated.token}` },
          }),
        )
      ).status,
    ).toBe(401);
  });
});

describe('integration: native SCIM directory-bearer tenant crossings', () => {
  for (const key of Object.keys(SCIM_CROSS_TENANT)) {
    test(`${key} refuses another directory resource and accepts the actual owning bearer`, async () => {
      const a = await setup();
      const b = await setup();
      const [method = '', path = ''] = key.split(' ');
      const kind = path.includes('/Users/') ? 'Users' : 'Groups';
      const externalId = crypto.randomUUID();
      const attributes =
        kind === 'Users'
          ? {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              externalId,
              userName: `${externalId}@company.example`,
              displayName: 'Scoped employee',
              active: true,
            }
          : {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
              externalId,
              displayName: 'Scoped group',
              members: [],
            };
      const created = await call(a, 'POST', kind, attributes);
      expect(created.status).toBe(201);
      const id = await resourceId(created);
      const body =
        method === 'DELETE'
          ? undefined
          : method === 'PUT'
            ? attributes
            : {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [{ op: 'replace', path: 'displayName', value: 'Scoped replacement' }],
              };
      const foreign = await call(b, method, `${kind}/${id}`, body);
      expect(foreign.status).toBe(404);
      expect(foreign.headers.get('content-type')).toContain('application/scim+json');
      const denied: unknown = await foreign.json();
      const missing = await call(b, method, `${kind}/${crypto.randomUUID()}`, body);
      expect({ status: missing.status, body: await missing.json() }).toEqual({
        status: 404,
        body: denied,
      });
      const stillOwned = await call(a, 'GET', `${kind}/${id}`);
      expect(stillOwned.status).toBe(200);
      expect((await call(a, method, `${kind}/${id}`, body)).status).toBe(
        method === 'DELETE' ? 204 : 200,
      );
    });
  }
});

const directoryRefusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
    return 'accepted';
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
};
const anotherDirectoryConnection = async (
  f: Awaited<ReturnType<typeof setup>>,
): Promise<string> => {
  const connection = await clone.db
    .selectFrom('workspace_identity_connections')
    .select('domain_id')
    .where('id', '=', f.configured.connection.id)
    .executeTakeFirstOrThrow();
  return (
    await createCompanyConnection(f.configured.fixture.dependencies, f.configured.fixture.actor, {
      domainId: connection.domain_id,
      name: crypto.randomUUID(),
      issuer: f.configured.idp.issuer(),
      ...OIDC_STUB_CREDENTIALS,
    })
  ).id;
};
describe('integration: directory administration and verified identity boundaries', () => {
  test('readiness, stale revisions, missing connections and duplicate names refuse before changing directory configuration', async () => {
    const f = await setup();
    for (const readersReady of [
      (): Promise<boolean> => Promise.resolve(false),
      (): Promise<boolean> => Promise.reject(new Error('Peer unavailable')),
    ])
      expect(
        await directoryRefusal(
          updateWorkspaceDirectory(
            { ...f.dependencies, readersReady },
            f.configured.fixture.actor,
            f.directory.id,
            { revision: f.directory.revision, name: 'Peer blocked' },
          ),
        ),
      ).toBe('WORKSPACE_DIRECTORY_NOT_READY');
    expect(
      await directoryRefusal(
        updateWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, f.directory.id, {
          revision: crypto.randomUUID(),
          name: 'Stale',
        }),
      ),
    ).toBe('WORKSPACE_DIRECTORY_CHANGED');
    expect(
      await directoryRefusal(
        updateWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, crypto.randomUUID(), {
          revision: f.directory.revision,
          name: 'Missing',
        }),
      ),
    ).toBe('WORKSPACE_DIRECTORY_NOT_FOUND');
    expect(
      await directoryRefusal(
        updateWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, f.directory.id, {
          revision: f.directory.revision,
          name: ' padded ',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await directoryRefusal(
        createWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, {
          name: 'Missing connection',
          connectionId: crypto.randomUUID(),
          claim: 'sub',
          allowCreate: false,
        }),
      ),
    ).toBe('WORKSPACE_DIRECTORY_NOT_FOUND');
    const secondConnection = await anotherDirectoryConnection(f);
    expect(
      await directoryRefusal(
        createWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, {
          name: f.directory.name,
          connectionId: secondConnection,
          claim: 'sub',
          allowCreate: false,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const second = await createWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, {
      name: 'Second directory',
      connectionId: secondConnection,
      claim: 'sub',
      allowCreate: false,
    });
    expect(
      await directoryRefusal(
        updateWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, second.id, {
          revision: second.revision,
          name: f.directory.name,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await directoryRefusal(
        createWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, {
          name: ' padded ',
          connectionId: f.configured.connection.id,
          claim: 'sub',
          allowCreate: false,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    for (let index = 2; index < 8; index += 1)
      await createWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, {
        name: `Directory ${String(index)}`,
        connectionId: await anotherDirectoryConnection(f),
        claim: 'sub',
        allowCreate: false,
      });
    expect(
      await directoryRefusal(
        createWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, {
          name: 'Ninth directory',
          connectionId: crypto.randomUUID(),
          claim: 'sub',
          allowCreate: false,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      (await listWorkspaceDirectories(f.dependencies, f.configured.fixture.actor)).data,
    ).toHaveLength(8);
  });
  test('overlapping credentials shorten the old expiry and enforce the five-live limit without losing valid metadata', async () => {
    const f = await setup();
    let directory = f.directory;
    for (let index = 0; index < 4; index += 1) {
      const issued = await rotateDirectoryCredential(
        f.dependencies,
        f.configured.fixture.actor,
        directory.id,
        { revision: directory.revision, expiresInDays: 30, overlapMinutes: 10 },
      );
      directory = issued.directory;
    }
    expect(directory.credentials.filter((row) => row.revokedAt === null)).toHaveLength(5);
    expect(
      directory.credentials.some(
        (row) => new Date(row.expiresAt).getTime() < systemClock.now().getTime() + 11 * 60_000,
      ),
    ).toBe(true);
    expect(
      await directoryRefusal(
        rotateDirectoryCredential(f.dependencies, f.configured.fixture.actor, directory.id, {
          revision: directory.revision,
          expiresInDays: 30,
          overlapMinutes: 10,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const disabled = await updateWorkspaceDirectory(
      f.dependencies,
      f.configured.fixture.actor,
      directory.id,
      { revision: directory.revision, enabled: false },
    );
    expect(disabled.enabled).toBe(false);
    expect((await call(f, 'POST', 'Users', user(crypto.randomUUID()))).status).toBe(401);
  });
  test('the configured verified oid requires an exact canonical consent and active source, never another subject or a missing claim', async () => {
    const f = await setup(noWorkspaceChannels, 'oid');
    const connection = (
      await listCompanyConnections(f.configured.fixture.dependencies, f.configured.fixture.actor)
    ).data.find((row) => row.id === f.configured.connection.id);
    if (connection === undefined) throw new Error('Missing classified connection.');
    const linkBody = {
      workspaceId: f.configured.fixture.actor.context.workspaceId,
      connectionId: connection.id,
      revision: connection.revision,
      intent: 'link',
    };
    const external = crypto.randomUUID();
    f.configured.idp.person = { sub: 'oid-consenting-person', email: 'oid-person@company.example' };
    expect(
      (await roundtripCompanyNative(f.configured, linkBody, f.configured.memberCookie)).status,
    ).toBe(409);
    f.configured.idp.behaviour.claims = { oid: 'not-an-oid' };
    expect(
      (await roundtripCompanyNative(f.configured, linkBody, f.configured.memberCookie)).status,
    ).toBe(409);
    f.configured.idp.behaviour.claims = { oid: external };
    expect(
      (await roundtripCompanyNative(f.configured, linkBody, f.configured.memberCookie)).status,
    ).toBe(302);
    expect(
      await clone.db
        .selectFrom('workspace_directory_identity_links')
        .select(['user_id', 'origin'])
        .where('directory_id', '=', f.directory.id)
        .where('external_id', '=', external)
        .executeTakeFirstOrThrow(),
    ).toEqual({ user_id: f.configured.fixture.member.context.userId, origin: 'company_link' });
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', f.configured.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    const signIn = { workspace: workspace.slug, connectionId: connection.id };
    expect((await roundtripCompanyNative(f.configured, signIn, '', true)).status).toBe(409);
    const created = await call(f, 'POST', 'Users', user(external));
    expect(created.status).toBe(201);
    expect((await roundtripCompanyNative(f.configured, signIn, '', true)).status).toBe(302);
    f.configured.idp.person = {
      sub: 'another-subject-with-same-oid',
      email: 'other@company.example',
    };
    expect(
      (await roundtripCompanyNative(f.configured, linkBody, f.configured.ownerCookie)).status,
    ).toBe(409);
    f.configured.idp.person = { sub: 'oid-consenting-person', email: 'oid-person@company.example' };
    await clone.db.transaction().execute(async (tx) => {
      const scope = await lockWorkspaceProjectionScope(
        tx,
        f.configured.fixture.actor.context.workspaceId,
      );
      await blockWorkspaceAdmission(
        tx,
        systemClock,
        scope,
        f.configured.fixture.member.context.userId,
      );
    });
    expect((await roundtripCompanyNative(f.configured, signIn, '', true)).status).toBe(409);
  });
});

describe('integration: terminal directory proof lifecycle', () => {
  test('disabling and deleting a directory ends its actual issued proof while retaining terminal native classification', async () => {
    const f = await setup();
    const external = crypto.randomUUID();
    const email = `${external}@company.example`;
    expect((await call(f, 'POST', 'Users', user(external, email))).status).toBe(201);
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', f.configured.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    f.configured.idp.person = { sub: external, email };
    const login = await roundtripCompanyNative(
      f.configured,
      { workspace: workspace.slug, connectionId: f.configured.connection.id },
      '',
      true,
    );
    expect(login.status).toBe(302);
    const cookie = login.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${COMPANY_SESSION_COOKIE}=`))
      ?.split(';')[0];
    if (cookie === undefined) throw new Error('Missing actual directory cookie.');
    const session = await sessionFromHeaders(f.configured.auth, new Headers({ cookie }), {
      recordActivity: false,
    });
    if (session === undefined) throw new Error('Missing issued directory proof.');
    const disabled = await updateWorkspaceDirectory(
      f.dependencies,
      f.configured.fixture.actor,
      f.directory.id,
      { revision: f.directory.revision, enabled: false },
    );
    expect(
      await sessionFromHeaders(f.configured.auth, new Headers({ cookie }), {
        recordActivity: false,
      }),
    ).toBeUndefined();
    await deleteWorkspaceDirectory(
      f.dependencies,
      f.configured.fixture.actor,
      disabled.id,
      disabled.revision,
    );
    expect(
      (
        await clone.db
          .selectFrom('workspace_directories')
          .select('deleted_at')
          .where('id', '=', disabled.id)
          .executeTakeFirstOrThrow()
      ).deleted_at,
    ).not.toBeNull();
    expect(
      (
        await clone.db
          .selectFrom('sessions')
          .select('directory_id')
          .where('id', '=', session.sessionId)
          .executeTakeFirstOrThrow()
      ).directory_id,
    ).toBe(disabled.id);
    expect(
      await directoryRefusal(
        updateWorkspaceDirectory(f.dependencies, f.configured.fixture.actor, disabled.id, {
          revision: disabled.revision,
          enabled: true,
        }),
      ),
    ).toBe('WORKSPACE_DIRECTORY_NOT_FOUND');
    expect(
      (
        await sessionFromHeaders(
          f.configured.auth,
          new Headers({ cookie: f.configured.memberCookie }),
          { recordActivity: false },
        )
      )?.userId,
    ).toBe(f.configured.fixture.member.context.userId);
  });
});
