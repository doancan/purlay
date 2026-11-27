/** Mounted native SCIM verbs/media and owner configuration run through real HTTP routing and SQL. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  type UserRole,
} from '@purlay/db';
import { WorkspaceDirectory, IssuedDirectoryCredential } from '@purlay/types/workspace-directory';
import { compose } from '../../composition';
import { systemClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { aUserRow, aUniqueSlug } from '../../testing/users';
import { testConfig, testDependencies } from '../../testing/doubles';
import { noWorkspaceChannels } from '../../modules/workspaces/channels-port';
import { createApp } from './app';
import { noDepartures } from '../../testing/departures';
let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const idOf = (body: unknown): string => {
  if (typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string')
    throw new Error('Missing SCIM resource ID.');
  return body.id;
};
const scim = '/auth/scim/v2';
const listSchema = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const withFilter = (
  resource: 'Users' | 'Groups',
  filter: string,
  excludedAttributes?: string,
): string => {
  const query = new URLSearchParams({
    filter,
    ...(excludedAttributes === undefined ? {} : { excludedAttributes }),
  });
  return `${scim}/${resource}?${query.toString()}`;
};

const scimList = async (response: Response): Promise<unknown> => {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/scim+json');
  const body: unknown = await response.json();
  return body;
};

const resourcesOf = (list: unknown): readonly unknown[] => {
  if (
    list === null ||
    typeof list !== 'object' ||
    !('Resources' in list) ||
    !Array.isArray(list.Resources)
  )
    throw new Error('Invalid SCIM resource list.');
  return list.Resources;
};

describe('integration: mounted native directory protocol', () => {
  test('a core-only directory supports provider connection tests, filtered reads and provisioning through its issued bearer', async () => {
    const owner = await aUserRow(clone.db, 'directory-http-owner');
    const workspace = await clone.db
      .insertInto('workspaces')
      .values({ name: 'Directory HTTP', slug: aUniqueSlug('directory-http') })
      .returning('id')
      .executeTakeFirstOrThrow();
    await clone.db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: owner.userId, role: 'owner' })
      .execute();
    const session = await aSession(clone.db, systemClock, owner.userId);
    const now = systemClock.now();
    const domain = await clone.db
      .insertInto('workspace_identity_domains')
      .values({
        workspace_id: workspace.id,
        domain: 'directory.example',
        challenge_issued_at: now,
        challenge_expires_at: new Date(now.getTime() + 86_400_000),
        verified_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const auth = aTestAuth(clone.db, {
      directory: {
        channels: noWorkspaceChannels,
        departures: noDepartures,
        readersReady: () => Promise.resolve(true),
      },
    });
    const app = createApp(
      testDependencies({
        database: clone.db,
        auth,
        clock: systemClock,
        composition: compose([]),
        config: testConfig({ WORKSPACE_PROVISIONING_READY: true }),
      }),
    );
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      bearer?: string,
      media = 'application/json',
    ): Promise<Response> =>
      await app.handle(
        new Request(`https://purlay.test${path}`, {
          method,
          headers: {
            ...(bearer === undefined
              ? { origin: 'https://purlay.test', cookie: `${SESSION_COOKIE}=${session.token}` }
              : { authorization: `Bearer ${bearer}` }),
            ...(body === undefined ? {} : { 'content-type': media }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const root = `/api/workspaces/${workspace.id}/directories`;
    const directoryCredential = async (name: string): Promise<IssuedDirectoryCredential> => {
      const revision = crypto.randomUUID();
      const connection = await clone.db
        .insertInto('workspace_identity_connections')
        .values({
          workspace_id: workspace.id,
          domain_id: domain.id,
          name,
          issuer: 'https://directory.example',
          client_id: 'fixture',
          client_secret_encrypted: Buffer.alloc(32, 1),
          enabled: true,
          authentication_revision: revision,
          tested_authentication_revision: revision,
          tested_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const created = await call('POST', root, {
        name,
        connectionId: connection.id,
        claim: 'sub',
        allowCreate: true,
      });
      expect(created.status).toBe(201);
      const directory: unknown = await created.json();
      if (!Value.Check(WorkspaceDirectory, directory))
        throw new Error('Invalid directory contract.');
      const enabled = await call('PATCH', `${root}/${directory.id}`, {
        revision: directory.revision,
        enabled: true,
      });
      expect(enabled.status).toBe(200);
      const current: unknown = await enabled.json();
      if (!Value.Check(WorkspaceDirectory, current))
        throw new Error('Invalid enabled directory contract.');
      const issued = await call('POST', `${root}/${directory.id}/credentials`, {
        revision: current.revision,
        expiresInDays: 1,
        overlapMinutes: 0,
      });
      expect(issued.status).toBe(201);
      expect(issued.headers.get('cache-control')).toBe('no-store');
      const credential: unknown = await issued.json();
      if (!Value.Check(IssuedDirectoryCredential, credential))
        throw new Error('Invalid issued credential contract.');
      return credential;
    };
    const credential = await directoryCredential('Corporate directory');
    const discovery = await scimList(
      await call('GET', `${scim}/Schemas`, undefined, credential.token),
    );
    expect(discovery).toMatchObject({ schemas: [listSchema] });
    const schemaIds = resourcesOf(discovery).map(idOf);
    expect(schemaIds).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
    expect(schemaIds).toContain('urn:ietf:params:scim:schemas:core:2.0:Group');

    // Entra tests the connection by looking up a non-existent user using a bare random GUID.
    expect(
      await scimList(
        await call(
          'GET',
          withFilter('Users', `userName eq "${crypto.randomUUID()}"`),
          undefined,
          credential.token,
        ),
      ),
    ).toMatchObject({ schemas: [listSchema], totalResults: 0, Resources: [] });

    const external = crypto.randomUUID();
    const body = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: external,
      userName: `${external}@directory.example`,
      displayName: 'Employee',
      active: true,
    };
    const post = await call(
      'POST',
      `${scim}/Users`,
      body,
      credential.token,
      'application/scim+json',
    );
    expect(post.status).toBe(201);
    expect(post.headers.get('content-type')).toContain('application/scim+json');
    const id = idOf(await post.json());
    const userLookup = withFilter('Users', `userName eq "${body.userName}"`);
    expect(
      await scimList(await call('GET', userLookup, undefined, credential.token)),
    ).toMatchObject({
      schemas: [listSchema],
      totalResults: 1,
      Resources: [{ id, userName: body.userName, active: true }],
    });
    expect(
      (
        await call(
          'PUT',
          `${scim}/Users/${id}`,
          { ...body, displayName: 'Provider display' },
          credential.token,
          'application/scim+json',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'PATCH',
          `${scim}/Users/${id}`,
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'displayName', value: 'New provider label' }],
          },
          credential.token,
          'application/scim+json',
        )
      ).status,
    ).toBe(200);
    const employee = await clone.db
      .selectFrom('workspace_directory_scim_users')
      .select('user_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const membershipRole = async (): Promise<UserRole | undefined> =>
      (
        await clone.db
          .selectFrom('workspace_members')
          .select('role')
          .where('workspace_id', '=', workspace.id)
          .where('user_id', '=', employee.user_id)
          .executeTakeFirst()
      )?.role;
    expect(await membershipRole()).toBe('member');
    for (const active of [false, true]) {
      const patched = await call(
        'PATCH',
        `${scim}/Users/${id}`,
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'Replace', path: 'active', value: active }],
        },
        credential.token,
        'application/scim+json',
      );
      expect(patched.status).toBe(200);
      expect(
        await scimList(await call('GET', userLookup, undefined, credential.token)),
      ).toMatchObject({ totalResults: 1, Resources: [{ id, active }] });
      expect(await membershipRole()).toBe(active ? 'member' : undefined);
    }
    const groupResponse = await call(
      'POST',
      `${scim}/Groups`,
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Finance',
        members: [{ value: id }],
      },
      credential.token,
      'application/scim+json',
    );
    expect(groupResponse.status).toBe(201);
    const groupId = idOf(await groupResponse.json());
    const groupLookup = withFilter('Groups', 'displayName eq "Finance"', 'members');
    const groups = await scimList(await call('GET', groupLookup, undefined, credential.token));
    expect(groups).toMatchObject({
      schemas: [listSchema],
      totalResults: 1,
      Resources: [{ id: groupId, displayName: 'Finance' }],
    });
    expect(resourcesOf(groups)[0]).not.toHaveProperty('members');
    const other = await directoryCredential('Other company directory');
    for (const lookup of [userLookup, groupLookup]) {
      expect(await scimList(await call('GET', lookup, undefined, other.token))).toMatchObject({
        schemas: [listSchema],
        totalResults: 0,
        Resources: [],
      });
    }
    expect((await call('GET', `${scim}/Users/${id}`, undefined, other.token)).status).toBe(404);
    expect((await call('GET', `${scim}/Groups/${groupId}`, undefined, other.token)).status).toBe(
      404,
    );
    expect(
      (
        await call(
          'PATCH',
          `${scim}/Groups/${groupId}`,
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'displayName', value: 'Accounts' }],
          },
          credential.token,
          'application/scim+json',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'PUT',
          `${scim}/Groups/${groupId}`,
          {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
            displayName: 'Accounts',
            members: [],
          },
          credential.token,
          'application/scim+json',
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('DELETE', `${scim}/Groups/${groupId}`, undefined, credential.token)).status,
    ).toBe(204);
    const missing = await call(
      'GET',
      `${scim}/Users/${crypto.randomUUID()}`,
      undefined,
      credential.token,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/scim+json');
    expect(await missing.json()).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '404',
    });
    expect((await call('DELETE', `${scim}/Users/${id}`, undefined, credential.token)).status).toBe(
      204,
    );
    const closed = await call('PUT', '/auth/change-password', {}, credential.token);
    expect(closed.status).toBe(404);
    expect(await closed.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
    expect(
      (await call('POST', '/api/workspaces', {}, credential.token, 'application/scim+json')).status,
    ).toBe(415);
  });
});
