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
import { WorkspaceAccessRole, WorkspaceMemberAccess } from '@purlay/types/workspace-provisioning';
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

type DirectoryCall = (
  method: string,
  path: string,
  body?: unknown,
  bearer?: string,
  media?: string,
  cookie?: string,
) => Promise<Response>;

interface MountedDirectory extends AsyncDisposable {
  readonly workspace: { readonly id: string };
  readonly domainName: string;
  readonly directoryCredential: (name: string) => Promise<IssuedDirectoryCredential>;
  readonly call: DirectoryCall;
}

interface RemoveOperation {
  readonly op: 'remove' | 'Remove';
  readonly path: string;
  readonly value?: readonly { readonly $ref: null; readonly value: string }[];
}

describe('integration: mounted native directory protocol', () => {
  const mountedDirectory = async (): Promise<MountedDirectory> => {
    const owner = await aUserRow(clone.db, 'directory-http-owner');
    const domainName = `directory-${crypto.randomUUID()}.example`;
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
        domain: domainName,
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
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.handle });
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      bearer?: string,
      media = 'application/json',
      cookie = session.token,
    ): Promise<Response> =>
      await fetch(new URL(path, listener.url), {
        method,
        headers: {
          ...(bearer === undefined
            ? { origin: 'https://purlay.test', cookie: `${SESSION_COOKIE}=${cookie}` }
            : { authorization: `Bearer ${bearer}` }),
          ...(body === undefined ? {} : { 'content-type': media }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const root = `/api/workspaces/${workspace.id}/directories`;
    const directoryCredential = async (name: string): Promise<IssuedDirectoryCredential> => {
      const revision = crypto.randomUUID();
      const connection = await clone.db
        .insertInto('workspace_identity_connections')
        .values({
          workspace_id: workspace.id,
          domain_id: domain.id,
          name,
          issuer: `https://${domainName}`,
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
    return {
      workspace,
      domainName,
      directoryCredential,
      call,
      async [Symbol.asyncDispose](): Promise<void> {
        await listener.stop(true);
      },
    };
  };

  test('a core-only directory supports provider connection tests, filtered reads and provisioning through its issued bearer', async () => {
    await using directory = await mountedDirectory();
    const { workspace, domainName, directoryCredential, call } = directory;
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
      userName: `${external}@${domainName}`,
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

  test.each([
    [
      'RFC 7644 member value path',
      (id: string): RemoveOperation => ({
        op: 'remove',
        path: `members[value eq "${id}"]`,
      }),
    ],
    [
      'Entra outbound member array',
      (id: string): RemoveOperation => ({
        op: 'Remove',
        path: 'members',
        value: [{ $ref: null, value: id }],
      }),
    ],
  ])(
    'incremental Group PATCH removes only the intended group contribution via %s',
    async (_case, removal) => {
      await using directory = await mountedDirectory();
      const { workspace, domainName, directoryCredential, call } = directory;
      const credential = await directoryCredential('Finance directory');
      const scimCall = (method: string, path: string, body?: unknown): Promise<Response> =>
        call(method, `${scim}/${path}`, body, credential.token, 'application/scim+json');
      const [removed, sibling] = await Promise.all(
        ['removed', 'sibling'].map(async (name) => {
          const created = await scimCall('POST', 'Users', {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            externalId: crypto.randomUUID(),
            userName: `${name}@${domainName}`,
            active: true,
          });
          expect(created.status).toBe(201);
          const resourceId = idOf(await created.json());
          const { user_id: userId } = await clone.db
            .selectFrom('workspace_directory_scim_users')
            .select('user_id')
            .where('id', '=', resourceId)
            .executeTakeFirstOrThrow();
          const session = await aSession(clone.db, systemClock, userId);
          return { resourceId, userId, cookie: session.token };
        }),
      );
      if (removed === undefined || sibling === undefined) throw new Error('Two SCIM users needed.');
      const created = await scimCall('POST', 'Groups', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Finance',
        members: [{ value: removed.resourceId }, { value: sibling.resourceId }],
      });
      expect(created.status).toBe(201);
      const groupId = idOf(await created.json());
      const group = async (): Promise<{ id: string; revision: string }> =>
        await clone.db
          .selectFrom('workspace_access_groups')
          .select(['id', 'revision'])
          .where('workspace_id', '=', workspace.id)
          .where('directory_group_reference', '=', groupId)
          .executeTakeFirstOrThrow();
      const root = `/api/workspaces/${workspace.id}`;
      const removedAccess = `${root}/access/people/${removed.userId}`;
      const beforeManual: unknown = await (await call('GET', removedAccess)).json();
      if (!Value.Check(WorkspaceMemberAccess, beforeManual))
        throw new Error('Invalid member access.');
      const manual: unknown = await (
        await call('POST', `${removedAccess}/manual`, {
          revision: beforeManual.revision,
          role: 'member',
        })
      ).json();
      if (!Value.Check(WorkspaceMemberAccess, manual)) throw new Error('Invalid manual access.');
      const manualSource = manual.sources.find((source) => source.kind === 'manual');
      if (manualSource === undefined) throw new Error('Missing independent manual access.');
      const roleResponse = await call('POST', `${root}/access/roles`, {
        name: 'Finance audit reader',
        capabilities: ['audit.read'],
      });
      expect(roleResponse.status).toBe(201);
      const role: unknown = await roleResponse.json();
      if (!Value.Check(WorkspaceAccessRole, role)) throw new Error('Invalid audit role.');
      const target = await group();
      expect(
        (
          await call('POST', `${root}/access/grants`, {
            roleId: role.id,
            roleRevision: role.revision,
            subjectRevision: target.revision,
            subject: { kind: 'group', groupId: target.id },
            scope: { kind: 'workspace' },
          })
        ).status,
      ).toBe(201);
      const auditAccess = async (cookie: string): Promise<number> =>
        (await call('GET', `${root}/audit`, undefined, undefined, undefined, cookie)).status;
      expect(await auditAccess(removed.cookie)).toBe(200);
      expect(await auditAccess(sibling.cookie)).toBe(200);
      const changes = async (): Promise<number> =>
        (
          await clone.db
            .selectFrom('audit_log')
            .select('id')
            .where('workspace_id', '=', workspace.id)
            .where('action', '=', 'workspace.access.group_updated')
            .execute()
        ).length;
      const priorChanges = await changes();
      const patch = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [removal(removed.resourceId)],
      };
      const response = await scimCall('PATCH', `Groups/${groupId}`, patch);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/scim+json');
      expect(await response.json()).toMatchObject({
        id: groupId,
        members: [{ value: sibling.resourceId }],
      });
      expect(await auditAccess(removed.cookie)).toBe(403);
      expect(await auditAccess(sibling.cookie)).toBe(200);
      const remaining: unknown = await (await call('GET', removedAccess)).json();
      if (!Value.Check(WorkspaceMemberAccess, remaining))
        throw new Error('Invalid remaining access.');
      expect(remaining).toMatchObject({
        state: 'active',
        workspaceCapabilities: [],
        groupCount: 0,
      });
      expect(remaining.sources.find((source) => source.id === manualSource.id)).toEqual({
        ...manualSource,
        effective: true,
      });
      const changed = await group();
      expect(changed.revision).not.toBe(target.revision);
      expect(await changes()).toBe(priorChanges + 1);

      expect((await scimCall('PATCH', `Groups/${groupId}`, patch)).status).toBe(200);
      expect(await group()).toEqual(changed);
      expect(await changes()).toBe(priorChanges + 1);
    },
  );
});
