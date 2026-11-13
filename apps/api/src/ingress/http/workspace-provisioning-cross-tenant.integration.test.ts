/** Every source/grant/directory route crosses real tenants with valid current workflow bodies. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import {
  WorkspaceAccessGrant,
  WorkspaceAccessGrantPage,
  WorkspaceAccessGroup,
  WorkspaceAccessGroupCandidatePage,
  WorkspaceAccessGroupMemberPage,
  WorkspaceAccessGroupPage,
  WorkspaceAccessPeoplePage,
  WorkspaceAccessRole,
  WorkspaceAccessRolePage,
  WorkspaceMemberAccess,
  WorkspaceOffboardingPreview,
} from '@purlay/types/workspace-provisioning';
import {
  IssuedDirectoryCredential,
  WorkspaceDirectory,
  WorkspaceDirectoryPage,
} from '@purlay/types/workspace-directory';
import { systemClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { PROVISIONING_CROSS_TENANT } from '../../testing/cross-tenant';
import { setupCompanyNative } from '../../testing/company-native-auth';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aSession } from '../../testing/signed-in';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { createApp } from './app';

let owned: ClonedDatabase;
beforeAll(async () => {
  owned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await owned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const decoded = async <S extends TSchema>(
  response: Response,
  schema: S,
  status = 200,
): Promise<Static<S>> => {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  if (!Value.Check(schema, body))
    throw new Error('Positive provisioning response did not match its public contract.');
  return body;
};
const world = async (): Promise<{
  workspaceId: string;
  ownerId: string;
  owner: string;
  stranger: string;
  targetId: string;
  connectionId: string;
  call: (method: string, path: string, cookie: string, body?: unknown) => Promise<Response>;
  app: ReturnType<typeof createApp>;
}> => {
  const native = await setupCompanyNative(owned.db);
  const stranger = await aUserRow(owned.db, 'provisioning-stranger');
  const other = await owned.db
    .insertInto('workspaces')
    .values({ name: 'Other tenant', slug: aUniqueSlug('provisioning-other') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await owned.db
    .insertInto('workspace_members')
    .values({ workspace_id: other.id, user_id: stranger.userId, role: 'owner' })
    .execute();
  const session = await aSession(owned.db, systemClock, stranger.userId);
  const app = createApp(
    testDependencies({
      database: owned.db,
      auth: native.auth,
      clock: systemClock,
      config: testConfig({ WORKSPACE_PROVISIONING_READY: true }),
    }),
  );
  return {
    workspaceId: native.fixture.actor.context.workspaceId,
    ownerId: native.fixture.actor.context.userId,
    owner: native.ownerCookie,
    stranger: `${SESSION_COOKIE}=${session.token}`,
    targetId: native.fixture.member.context.userId,
    connectionId: native.connection.id,
    app,
    call: async (method, path, cookie, body): Promise<Response> =>
      await app.handle(
        new Request(`https://purlay.test${path}`, {
          method,
          headers: {
            cookie,
            origin: 'https://purlay.test',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
  };
};
type World = Awaited<ReturnType<typeof world>>;
interface Prepared {
  readonly path: string;
  readonly body?: unknown;
  readonly schema?: TSchema;
  readonly status: number;
}
const prepare = async (f: World, key: string): Promise<Prepared> => {
  const prefix = `/api/workspaces/${f.workspaceId}`;
  const own = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await f.call(method, prefix + path, f.owner, body);
  let access = await decoded(
    await own('GET', `/access/people/${f.targetId}`),
    WorkspaceMemberAccess,
  );
  const source = access.sources.find((row) => row.kind === 'manual');
  if (source === undefined) throw new Error('Missing actual native manual source.');
  const role = await decoded(
    await own('POST', '/access/roles', { name: 'Crossing audit', capabilities: ['audit.read'] }),
    WorkspaceAccessRole,
    201,
  );
  let group = await decoded(
    await own('POST', '/access/groups', { name: 'Crossing group' }),
    WorkspaceAccessGroup,
    201,
  );
  group = await decoded(
    await own('PATCH', `/access/groups/${group.id}/members`, {
      revision: group.revision,
      addSourceIds: [source.id],
    }),
    WorkspaceAccessGroup,
  );
  const grantBody = {
    roleId: role.id,
    roleRevision: role.revision,
    subjectRevision: source.revision,
    subject: { kind: 'source', sourceId: source.id },
    scope: { kind: 'workspace' },
  };
  const grant = await decoded(
    await own('POST', '/access/grants', grantBody),
    WorkspaceAccessGrant,
    201,
  );
  let directory: WorkspaceDirectory | undefined;
  let credentialId = '';
  if (key !== 'POST /api/workspaces/:workspaceId/directories') {
    directory = await decoded(
      await own('POST', '/directories', {
        name: 'Crossing directory',
        connectionId: f.connectionId,
        claim: 'sub',
        allowCreate: false,
      }),
      WorkspaceDirectory,
      201,
    );
    const issued = await decoded(
      await own('POST', `/directories/${directory.id}/credentials`, {
        revision: directory.revision,
        expiresInDays: 30,
        overlapMinutes: 0,
      }),
      IssuedDirectoryCredential,
      201,
    );
    directory = issued.directory;
    credentialId = issued.credential.id;
  }
  access = await decoded(await own('GET', `/access/people/${f.targetId}`), WorkspaceMemberAccess);
  const path = key
    .slice(key.indexOf(' ') + 1)
    .replace(':workspaceId', f.workspaceId)
    .replace(':userId', f.targetId)
    .replace(':sourceId', source.id)
    .replace(':roleId', role.id)
    .replace(':groupId', group.id)
    .replace(':grantId', grant.id)
    .replace(':directoryId', directory?.id ?? '');
  const result = (schema: TSchema, body?: unknown, status = 200): Prepared => ({
    path,
    schema,
    status,
    ...(body === undefined ? {} : { body }),
  });
  switch (key) {
    case 'GET /api/workspaces/:workspaceId/access/people':
      return result(WorkspaceAccessPeoplePage);
    case 'GET /api/workspaces/:workspaceId/access/people/:userId':
      return result(WorkspaceMemberAccess);
    case 'POST /api/workspaces/:workspaceId/access/people/:userId/manual':
      return result(WorkspaceMemberAccess, { revision: access.revision, role: 'member' });
    case 'POST /api/workspaces/:workspaceId/access/people/:userId/sources/:sourceId/revoke':
      return result(WorkspaceMemberAccess, { revision: source.revision });
    case 'POST /api/workspaces/:workspaceId/access/people/:userId/offboarding/preview':
      return result(WorkspaceOffboardingPreview, { revision: access.revision });
    case 'POST /api/workspaces/:workspaceId/access/people/:userId/offboarding':
      return result(WorkspaceMemberAccess, { revision: access.revision, confirm: true });
    case 'POST /api/workspaces/:workspaceId/access/people/:userId/readmission': {
      access = await decoded(
        await own('POST', `/access/people/${f.targetId}/offboarding`, {
          revision: access.revision,
          confirm: true,
        }),
        WorkspaceMemberAccess,
      );
      return result(WorkspaceMemberAccess, { revision: access.revision, confirm: true });
    }
    case 'GET /api/workspaces/:workspaceId/access/roles':
      return result(WorkspaceAccessRolePage);
    case 'POST /api/workspaces/:workspaceId/access/roles':
      return result(
        WorkspaceAccessRole,
        { name: 'New crossing role', capabilities: ['audit.read'] },
        201,
      );
    case 'PATCH /api/workspaces/:workspaceId/access/roles/:roleId':
      return result(WorkspaceAccessRole, {
        revision: role.revision,
        name: 'Renamed crossing role',
      });
    case 'DELETE /api/workspaces/:workspaceId/access/roles/:roleId':
      return { path, status: 204, body: { revision: role.revision } };
    case 'GET /api/workspaces/:workspaceId/access/groups':
      return result(WorkspaceAccessGroupPage);
    case 'POST /api/workspaces/:workspaceId/access/groups':
      return result(WorkspaceAccessGroup, { name: 'New crossing group' }, 201);
    case 'PATCH /api/workspaces/:workspaceId/access/groups/:groupId':
      return result(WorkspaceAccessGroup, {
        revision: group.revision,
        name: 'Renamed crossing group',
      });
    case 'DELETE /api/workspaces/:workspaceId/access/groups/:groupId':
      return { path, status: 204, body: { revision: group.revision } };
    case 'GET /api/workspaces/:workspaceId/access/groups/:groupId/members':
      return result(WorkspaceAccessGroupMemberPage);
    case 'PATCH /api/workspaces/:workspaceId/access/groups/:groupId/members':
      return result(WorkspaceAccessGroup, {
        revision: group.revision,
        removeSourceIds: [source.id],
      });
    case 'GET /api/workspaces/:workspaceId/access/groups/:groupId/candidates':
      return result(WorkspaceAccessGroupCandidatePage);
    case 'GET /api/workspaces/:workspaceId/access/grants':
      return result(WorkspaceAccessGrantPage);
    case 'POST /api/workspaces/:workspaceId/access/grants':
      return result(WorkspaceAccessGrant, grantBody, 201);
    case 'DELETE /api/workspaces/:workspaceId/access/grants/:grantId':
      return { path, status: 204, body: { revision: grant.revision } };
    case 'GET /api/workspaces/:workspaceId/directories':
      return result(WorkspaceDirectoryPage);
    case 'POST /api/workspaces/:workspaceId/directories':
      return result(
        WorkspaceDirectory,
        {
          name: 'New crossing directory',
          connectionId: f.connectionId,
          claim: 'sub',
          allowCreate: false,
        },
        201,
      );
    case 'PATCH /api/workspaces/:workspaceId/directories/:directoryId':
      return result(WorkspaceDirectory, {
        revision: directory?.revision,
        name: 'Renamed crossing directory',
      });
    case 'DELETE /api/workspaces/:workspaceId/directories/:directoryId':
      return { path, status: 204, body: { revision: directory?.revision } };
    case 'POST /api/workspaces/:workspaceId/directories/:directoryId/credentials':
      return result(
        IssuedDirectoryCredential,
        { revision: directory?.revision, expiresInDays: 30, overlapMinutes: 0 },
        201,
      );
    case 'POST /api/workspaces/:workspaceId/directories/:directoryId/credentials/revoke':
      return result(WorkspaceDirectory, { revision: directory?.revision, credentialId });
    default:
      throw new Error(`Missing real provisioning crossing preparation: ${key}`);
  }
};

describe('integration: dedicated source and directory tenant crossings', () => {
  for (const key of Object.keys(PROVISIONING_CROSS_TENANT)) {
    test(`${key} refuses foreign/missing/malformed tenants and accepts the actual owner workflow`, async () => {
      const f = await world();
      const prepared = await prepare(f, key);
      const method = key.split(' ')[0] ?? '';
      const foreign = await f.call(method, prepared.path, f.stranger, prepared.body);
      expect(foreign.status).toBe(404);
      const refusal: unknown = await foreign.json();
      expect(refusal).toMatchObject({ error: { code: 'WORKSPACE_NOT_FOUND' } });
      for (const id of [crypto.randomUUID(), 'not-a-uuid']) {
        const denied = await f.call(
          method,
          prepared.path.replace(f.workspaceId, id),
          f.stranger,
          prepared.body,
        );
        expect({ status: denied.status, body: await denied.json() }).toEqual({
          status: 404,
          body: refusal,
        });
      }
      const positive = await f.call(method, prepared.path, f.owner, prepared.body);
      if (prepared.schema !== undefined) await decoded(positive, prepared.schema, prepared.status);
      else {
        expect(positive.status).toBe(prepared.status);
        expect(await positive.text()).toBe('');
      }
      await f.app.settled();
    });
  }
});

describe('integration: one native owner across workspace inventories', () => {
  test('one native owner of A and B sees only the exact workspace source/role/group/grant/directory inventory', async () => {
    const a = await world();
    const b = await world();
    await prepare(a, 'GET /api/workspaces/:workspaceId/access/roles');
    await prepare(b, 'GET /api/workspaces/:workspaceId/access/roles');
    await owned.db
      .insertInto('workspace_members')
      .values({ workspace_id: b.workspaceId, user_id: a.ownerId, role: 'owner' })
      .execute();
    for (const suffix of ['/access/roles', '/access/groups', '/access/grants', '/directories']) {
      const ids = async (f: World): Promise<readonly string[]> => {
        const response = await f.call('GET', `/api/workspaces/${f.workspaceId}${suffix}`, a.owner);
        expect(response.status).toBe(200);
        const value: unknown = await response.json();
        if (
          typeof value !== 'object' ||
          value === null ||
          !('data' in value) ||
          !Array.isArray(value.data)
        )
          throw new Error('Missing actual inventory page.');
        return value.data.map((row: unknown): string => {
          if (
            typeof row !== 'object' ||
            row === null ||
            !('id' in row) ||
            typeof row.id !== 'string'
          )
            throw new Error('Missing inventory resource ID.');
          return row.id;
        });
      };
      const aIds = await ids(a);
      const bIds = await ids(b);
      expect(aIds.length > 0 && bIds.length > 0).toBe(true);
      expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    }
    for (const [f, absent] of [
      [a, b.targetId],
      [b, a.targetId],
    ] as const) {
      const people = await decoded(
        await f.call('GET', `/api/workspaces/${f.workspaceId}/access/people`, a.owner),
        WorkspaceAccessPeoplePage,
      );
      expect(people.data.some((row) => row.user.id === absent)).toBe(false);
    }
    await a.app.settled();
    await b.app.settled();
  });
});
