/** Lazy endpoint facades construct source-aware, revision-bound HTTP requests and decode every response. */
import { expect, test } from 'bun:test';
import type {
  WorkspaceAccessGroup,
  WorkspaceAccessRole,
  WorkspaceAccessSourceSummary,
  WorkspaceMemberAccess,
  WorkspaceAccessPerson,
  WorkspaceAccessGrant,
} from '@purlay/types/workspace-provisioning';
import type {
  WorkspaceDirectory,
  IssuedDirectoryCredential,
} from '@purlay/types/workspace-directory';
import { createApi } from './api';
import { createHttp } from './http';
import { IDS, ALICE, WHEN } from '../testing/fixtures';
import { ApiError } from './errors';

const role: WorkspaceAccessRole = {
  id: IDS.api,
  revision: IDS.alice,
  name: 'Recruiter',
  capabilities: ['members.invite'],
  retiredAt: null,
};
const group: WorkspaceAccessGroup = {
  id: IDS.browse,
  revision: IDS.bob,
  name: 'Staff',
  kind: 'manual',
  directoryId: null,
  memberCount: 1,
  retiredAt: null,
};
const source: WorkspaceAccessSourceSummary = {
  id: IDS.deploys,
  revision: IDS.me,
  kind: 'manual',
  state: 'active',
  builtinRole: 'member',
  effective: true,
  name: null,
  directoryId: null,
};
const access: WorkspaceMemberAccess = {
  userId: IDS.alice,
  revision: IDS.bob,
  state: 'active',
  role: 'member',
  accessKind: 'member',
  workspaceCapabilities: [],
  sources: [source],
  groupCount: 0,
};
const person: WorkspaceAccessPerson = { id: IDS.alice, user: ALICE, access };
const grant: WorkspaceAccessGrant = {
  id: IDS.dm,
  revision: IDS.bob,
  roleId: role.id,
  role,
  subject: { kind: 'group', groupId: group.id, group },
  scope: { kind: 'channel', channelId: IDS.incidents, name: 'help', type: 'private' },
  createdAt: WHEN,
};
const directory: WorkspaceDirectory = {
  id: IDS.browse,
  revision: IDS.me,
  name: 'Office',
  enabled: true,
  allowCreate: false,
  connectionId: IDS.deploys,
  claim: 'sub',
  scimUrl: 'https://purlay.test/scim/v2/office',
  credentials: [],
  createdAt: WHEN,
  updatedAt: WHEN,
};
const issued: IssuedDirectoryCredential = {
  directory,
  credential: { id: IDS.api, createdAt: WHEN, expiresAt: WHEN, revokedAt: null, lastUsedAt: null },
  token: 'x'.repeat(112),
};
const setup = (): {
  readonly api: ReturnType<typeof createApi>;
  readonly seen: { url: string; init: RequestInit }[];
  readonly reply: (value: unknown, status?: number) => void;
} => {
  let value: unknown = null;
  let status = 200;
  const seen: { url: string; init: RequestInit }[] = [];
  return {
    api: createApi(
      createHttp((url, init) => {
        seen.push({ url, init });
        return Promise.resolve(
          status === 204 ? new Response(null, { status }) : Response.json(value, { status }),
        );
      }),
    ),
    seen,
    reply: (next, code = 200): void => {
      value = next;
      status = code;
    },
  };
};

test('all access reads preserve workspace/path escaping, search, keyset cursors and exact subject filters', async () => {
  const { api, seen, reply } = setup();
  const wid = 'workspace/with space';
  const root = '/api/workspaces/workspace%2Fwith%20space/access';
  const query = { before: IDS.bob, limit: 40, q: 'Office staff' };
  const page = <T>(item: T): { data: T[]; nextCursor: null } => ({
    data: [item],
    nextCursor: null,
  });
  reply(page(person));
  expect(await api.workspaceAccessPeople(wid, { ...query, state: 'inactive' })).toEqual(
    page(person),
  );
  reply(access);
  expect(await api.workspaceMemberAccess(wid, IDS.alice)).toEqual(access);
  reply(page(role));
  expect(await api.workspaceAccessRoles(wid, query)).toEqual(page(role));
  reply(page(group));
  expect(await api.workspaceAccessGroups(wid, query)).toEqual(page(group));
  const member = {
    id: IDS.browse,
    userId: IDS.alice,
    user: ALICE,
    sourceId: source.id,
    source,
    joinedAt: WHEN,
  };
  reply(page(member));
  expect(await api.workspaceAccessGroupMembers(wid, group.id, query)).toEqual(page(member));
  const candidate = { id: source.id, user: ALICE, source };
  reply(page(candidate));
  expect(
    await api.workspaceAccessGroupCandidates(wid, group.id, {
      ...query,
      before: `${IDS.bob}:${source.id}`,
    }),
  ).toEqual(page(candidate));
  reply(page(grant));
  expect(await api.workspaceAccessGrants(wid, { ...query, groupId: group.id })).toEqual(
    page(grant),
  );
  await api.workspaceAccessGrants(wid, { sourceId: source.id });
  expect(seen).toHaveLength(8);
  expect(seen.every((item) => item.init.method === 'GET')).toBe(true);
  expect(seen[0]?.url).toBe(
    `${root}/people?before=${IDS.bob}&limit=40&q=Office+staff&state=inactive`,
  );
  expect(seen[1]?.url).toBe(`${root}/people/${IDS.alice}`);
  expect(seen[2]?.url).toBe(`${root}/roles?before=${IDS.bob}&limit=40&q=Office+staff`);
  expect(seen[3]?.url).toBe(`${root}/groups?before=${IDS.bob}&limit=40&q=Office+staff`);
  expect(seen[4]?.url).toBe(
    `${root}/groups/${group.id}/members?before=${IDS.bob}&limit=40&q=Office+staff`,
  );
  expect(seen[5]?.url).toBe(
    `${root}/groups/${group.id}/candidates?before=${IDS.bob}%3A${source.id}&limit=40&q=Office+staff`,
  );
  expect(seen[6]?.url).toBe(
    `${root}/grants?before=${IDS.bob}&limit=40&q=Office+staff&groupId=${group.id}`,
  );
  expect(seen[7]?.url).toBe(`${root}/grants?sourceId=${source.id}`);
});

test('all access writes preserve revision fences and distinguish single-source changes from full lifecycle changes', async () => {
  const { api, seen, reply } = setup();
  const wid = IDS.workspace;
  const root = `/api/workspaces/${wid}/access`;
  const revision = { revision: IDS.bob };
  const assignment = {
    roleId: role.id,
    roleRevision: role.revision,
    subject: { kind: 'source' as const, sourceId: source.id },
    subjectRevision: source.revision,
    scope: { kind: 'workspace' as const },
  };
  const cases: readonly [string, string, unknown, unknown, () => Promise<unknown>][] = [
    [
      'POST',
      'roles',
      { name: role.name, capabilities: role.capabilities },
      role,
      (): Promise<unknown> =>
        api.createWorkspaceAccessRole(wid, { name: role.name, capabilities: role.capabilities }),
    ],
    [
      'PATCH',
      `roles/${role.id}`,
      { ...revision, name: 'New role' },
      role,
      (): Promise<unknown> =>
        api.updateWorkspaceAccessRole(wid, role.id, { ...revision, name: 'New role' }),
    ],
    [
      'DELETE',
      `roles/${role.id}`,
      revision,
      undefined,
      (): Promise<unknown> => api.retireWorkspaceAccessRole(wid, role.id, revision),
    ],
    [
      'POST',
      'groups',
      { name: group.name },
      group,
      (): Promise<unknown> => api.createWorkspaceAccessGroup(wid, { name: group.name }),
    ],
    [
      'PATCH',
      `groups/${group.id}`,
      { ...revision, name: 'New group' },
      group,
      (): Promise<unknown> =>
        api.updateWorkspaceAccessGroup(wid, group.id, { ...revision, name: 'New group' }),
    ],
    [
      'DELETE',
      `groups/${group.id}`,
      revision,
      undefined,
      (): Promise<unknown> => api.retireWorkspaceAccessGroup(wid, group.id, revision),
    ],
    [
      'PATCH',
      `groups/${group.id}/members`,
      { ...revision, addSourceIds: [source.id] },
      group,
      (): Promise<unknown> =>
        api.updateWorkspaceAccessGroupMembers(wid, group.id, {
          ...revision,
          addSourceIds: [source.id],
        }),
    ],
    [
      'POST',
      'grants',
      assignment,
      grant,
      (): Promise<unknown> => api.assignWorkspaceAccessGrant(wid, assignment),
    ],
    [
      'DELETE',
      `grants/${grant.id}`,
      revision,
      undefined,
      (): Promise<unknown> => api.revokeWorkspaceAccessGrant(wid, grant.id, revision),
    ],
    [
      'POST',
      `people/${IDS.alice}/manual`,
      { ...revision, role: 'member' },
      access,
      (): Promise<unknown> =>
        api.addManualWorkspaceAccess(wid, IDS.alice, { ...revision, role: 'member' }),
    ],
    [
      'POST',
      `people/${IDS.alice}/sources/${source.id}/revoke`,
      revision,
      access,
      (): Promise<unknown> => api.revokeWorkspaceAccessSource(wid, IDS.alice, source.id, revision),
    ],
    [
      'POST',
      `people/${IDS.alice}/offboarding/preview`,
      revision,
      { access, affectedChannelCount: 3, sourceSessionCount: 2, canOffboard: true, reason: null },
      (): Promise<unknown> => api.previewWorkspaceOffboarding(wid, IDS.alice, revision),
    ],
    [
      'POST',
      `people/${IDS.alice}/offboarding`,
      { ...revision, confirm: true },
      access,
      (): Promise<unknown> =>
        api.confirmWorkspaceOffboarding(wid, IDS.alice, { ...revision, confirm: true }),
    ],
    [
      'POST',
      `people/${IDS.alice}/readmission`,
      { ...revision, confirm: true },
      access,
      (): Promise<unknown> =>
        api.readmitWorkspaceMember(wid, IDS.alice, { ...revision, confirm: true }),
    ],
  ];
  for (const [method, path, body, response, call] of cases) {
    reply(response, response === undefined ? 204 : 200);
    expect(await call()).toEqual(response);
    const request = seen.at(-1);
    expect(request?.url).toBe(`${root}/${path}`);
    expect(request?.init.method).toBe(method);
    expect(request?.init.credentials).toBe('same-origin');
    expect(
      typeof request?.init.body === 'string' ? (JSON.parse(request.init.body) as unknown) : null,
    ).toEqual(body);
  }
});

test('directory facade decodes show-once tokens separately and fences every credential mutation', async () => {
  const { api, seen, reply } = setup();
  const wid = IDS.workspace;
  const root = `/api/workspaces/${wid}/directories`;
  reply({ data: [directory], nextCursor: null });
  await api.workspaceDirectories(wid, { before: IDS.bob, limit: 8 });
  expect(seen.at(-1)?.url).toBe(`${root}?before=${IDS.bob}&limit=8`);
  const input = {
    name: directory.name,
    connectionId: directory.connectionId,
    claim: directory.claim,
    allowCreate: false,
  };
  reply(directory);
  expect(await api.createWorkspaceDirectory(wid, input)).toEqual(directory);
  await api.updateWorkspaceDirectory(wid, directory.id, {
    revision: directory.revision,
    enabled: false,
  });
  reply(issued);
  expect(
    await api.rotateDirectoryCredential(wid, directory.id, {
      revision: directory.revision,
      expiresInDays: 90,
      overlapMinutes: 10,
    }),
  ).toEqual(issued);
  reply(directory);
  await api.revokeDirectoryCredential(wid, directory.id, {
    revision: directory.revision,
    credentialId: issued.credential.id,
  });
  reply(null, 204);
  await api.deleteWorkspaceDirectory(wid, directory.id, { revision: directory.revision });
  expect(seen.map((item) => [item.init.method, item.url.split('?')[0]])).toEqual([
    ['GET', root],
    ['POST', root],
    ['PATCH', `${root}/${directory.id}`],
    ['POST', `${root}/${directory.id}/credentials`],
    ['POST', `${root}/${directory.id}/credentials/revoke`],
    ['DELETE', `${root}/${directory.id}`],
  ]);
  expect(seen.every((item) => !item.url.includes(issued.token))).toBe(true);
});

test('malformed enriched responses and source-specific candidates are rejected at the lazy decoder boundary', async () => {
  const { api, reply } = setup();
  reply({
    data: [
      {
        ...grant,
        scope: { kind: 'channel', channelId: IDS.dm, name: 'hidden', type: 'direct_message' },
      },
    ],
    nextCursor: null,
  });
  expect(await failureOf(api.workspaceAccessGrants(IDS.workspace))).toMatchObject({
    code: 'MALFORMED',
  });
  reply({ data: [{ id: source.id, source }], nextCursor: null });
  expect(
    await failureOf(api.workspaceAccessGroupCandidates(IDS.workspace, group.id)),
  ).toBeInstanceOf(ApiError);
  reply({ ...issued, token: 'short' });
  expect(
    await failureOf(
      api.rotateDirectoryCredential(IDS.workspace, directory.id, {
        revision: directory.revision,
        expiresInDays: 90,
        overlapMinutes: 0,
      }),
    ),
  ).toMatchObject({ code: 'MALFORMED' });
});

const failureOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => {
      throw new Error('Expected request refusal');
    },
    (failure: unknown) => failure,
  );
