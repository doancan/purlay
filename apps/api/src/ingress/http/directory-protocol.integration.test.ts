/** Mounted native SCIM verbs/media and owner configuration run through real HTTP routing and SQL. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
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
let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const idOf = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string')
    throw new Error('Missing SCIM resource ID.');
  return body.id;
};
describe('integration: mounted native directory protocol', () => {
  test('native owner configures a core-only directory and its real bearer supports SCIM create/PUT/PATCH/DELETE and structured404 without opening other auth verbs', async () => {
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
    const revision = crypto.randomUUID();
    const connection = await clone.db
      .insertInto('workspace_identity_connections')
      .values({
        workspace_id: workspace.id,
        domain_id: domain.id,
        name: 'Directory fixture',
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
    const auth = aTestAuth(clone.db, {
      directory: { channels: noWorkspaceChannels, readersReady: () => Promise.resolve(true) },
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
            origin: 'https://purlay.test',
            ...(bearer === undefined
              ? { cookie: `${SESSION_COOKIE}=${session.token}` }
              : { authorization: `Bearer ${bearer}` }),
            ...(body === undefined ? {} : { 'content-type': media }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const root = `/api/workspaces/${workspace.id}/directories`;
    const created = await call('POST', root, {
      name: 'Corporate directory',
      connectionId: connection.id,
      claim: 'sub',
      allowCreate: true,
    });
    expect(created.status).toBe(201);
    const directory: unknown = await created.json();
    if (!Value.Check(WorkspaceDirectory, directory)) throw new Error('Invalid directory contract.');
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
    const external = crypto.randomUUID();
    const body = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: external,
      userName: `${external}@directory.example`,
      displayName: 'Employee',
      active: true,
    };
    const scim = '/auth/scim/v2';
    const post = await call(
      'POST',
      `${scim}/Users`,
      body,
      credential.token,
      'application/scim+json',
    );
    expect(post.status).toBe(201);
    expect(post.headers.get('content-type')).toContain('application/scim+json');
    const id = await idOf(post);
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
    const groupId = await idOf(groupResponse);
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
