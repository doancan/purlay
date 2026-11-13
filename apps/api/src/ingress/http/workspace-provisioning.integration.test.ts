/** Native core-only HTTP journeys exercise delegated authority, source changes and retained offboarding. */
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
import { ErrorResponse, MeResponse, type ErrorCode } from '@purlay/types';
import { AppError } from '../../platform/errors';
import {
  WorkspaceAccessGrant,
  WorkspaceAccessGroup,
  WorkspaceAccessGroupMemberPage,
  WorkspaceAccessPeoplePage,
  WorkspaceAccessRole,
  WorkspaceMemberAccess,
  WorkspaceOffboardingPreview,
} from '@purlay/types/workspace-provisioning';
import { compose } from '../../composition';
import { systemClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { createApp } from './app';

interface AccessHttpWorld {
  readonly app: ReturnType<typeof createApp>;
  readonly call: (
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
  ) => Promise<Response>;
  readonly owner: Awaited<ReturnType<typeof aUserRow>>;
  readonly person: Awaited<ReturnType<typeof aUserRow>>;
  readonly outsider: Awaited<ReturnType<typeof aUserRow>>;
  readonly workspaceId: string;
  readonly ownerCookie: string;
  readonly personCookie: string;
  readonly outsiderCookie: string;
  readonly root: string;
}

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const decoded = async <Schema extends TSchema>(
  response: Response,
  schema: Schema,
): Promise<Static<Schema>> => {
  const body: unknown = await response.json();
  const failure = Value.Check(ErrorResponse, body) ? body.error.code : 'contract';
  if (!Value.Check(schema, body))
    throw new Error(`Invalid access response (${String(response.status)} ${failure})`);
  return body;
};

const setup = async (peersBehind?: () => Promise<number>): Promise<AccessHttpWorld> => {
  const owner = await aUserRow(clone.db, 'access-owner');
  const person = await aUserRow(clone.db, 'access-person');
  const outsider = await aUserRow(clone.db, 'access-outsider');
  const workspace = await clone.db
    .insertInto('workspaces')
    .values({ name: 'Access fixture', slug: aUniqueSlug('access-http') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await clone.db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspace.id, user_id: owner.userId, role: 'owner' },
      { workspace_id: workspace.id, user_id: person.userId, role: 'member' },
    ])
    .execute();
  const sessions = await Promise.all(
    [owner, person, outsider].map(
      async (user) => await aSession(clone.db, systemClock, user.userId),
    ),
  );
  const cookies = sessions.map((session) => `${SESSION_COOKIE}=${session.token}`);
  const ownerCookie = cookies[0];
  const personCookie = cookies[1];
  const outsiderCookie = cookies[2];
  if (ownerCookie === undefined || personCookie === undefined || outsiderCookie === undefined)
    throw new Error('Missing native session');
  const app = createApp(
    testDependencies({
      database: clone.db,
      clock: systemClock,
      auth: aTestAuth(clone.db),
      composition: compose([]),
      ...(peersBehind === undefined ? {} : { workspaceProvisioningPeersBehind: peersBehind }),
      config: testConfig({ WORKSPACE_PROVISIONING_READY: true }),
    }),
  );
  const call = async (
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<Response> =>
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
    );
  return {
    app,
    call,
    owner,
    person,
    outsider,
    workspaceId: workspace.id,
    ownerCookie,
    personCookie,
    outsiderCookie,
    root: `/api/workspaces/${workspace.id}/access`,
  };
};

describe('integration: core-only workspace access HTTP', () => {
  test('an actual peer-readiness refusal writes nothing and an explicit retry proceeds after every reader catches up', async () => {
    let behind = 1;
    let checks = 0;
    const world = await setup(() => {
      checks++;
      return Promise.resolve(behind);
    });
    const input = { name: 'Ready readers only', capabilities: ['audit.read'] };
    const refused = await world.call('POST', `${world.root}/roles`, world.ownerCookie, input);
    expect(refused.status).toBe(409);
    expect(await decoded(refused, ErrorResponse)).toMatchObject({
      error: { code: 'WORKSPACE_PROVISIONING_NOT_READY' },
    });
    expect(
      await clone.db
        .selectFrom('workspace_access_roles')
        .select('id')
        .where('workspace_id', '=', world.workspaceId)
        .execute(),
    ).toEqual([]);
    behind = 0;
    const accepted = await world.call('POST', `${world.root}/roles`, world.ownerCookie, input);
    expect(accepted.status).toBe(201);
    expect(await decoded(accepted, WorkspaceAccessRole)).toMatchObject({ name: input.name });
    expect(checks).toBe(2);
    expect(
      await clone.db
        .selectFrom('audit_log')
        .select('id')
        .where('workspace_id', '=', world.workspaceId)
        .where('action', '=', 'workspace.access.role_created')
        .execute(),
    ).toHaveLength(1);
  });
  test('source-bound delegation reaches native audit authority and source revocation preserves global sign-in', async () => {
    const world = await setup();
    const target = `${world.root}/people/${world.person.userId}`;
    const people = await decoded(
      await world.call('GET', `${world.root}/people?q=access-person&limit=1`, world.ownerCookie),
      WorkspaceAccessPeoplePage,
    );
    expect(people.data.map((entry) => entry.user.id)).toEqual([world.person.userId]);
    const access = await decoded(
      await world.call('GET', target, world.ownerCookie),
      WorkspaceMemberAccess,
    );
    const source = access.sources.find((entry) => entry.kind === 'manual');
    if (source === undefined) throw new Error('Native manual admission was not initialized');
    const roleResponse = await world.call('POST', `${world.root}/roles`, world.ownerCookie, {
      name: 'Audit readers',
      capabilities: ['audit.read'],
    });
    expect(roleResponse.status).toBe(201);
    const role = await decoded(roleResponse, WorkspaceAccessRole);
    for (const path of [
      `${world.root}/roles?limit=1`,
      `${world.root}/grants?limit=1`,
      `/api/workspaces/${world.workspaceId}/directories?limit=1`,
    ])
      expect((await world.call('GET', path, world.ownerCookie)).status).toBe(200);
    const grant = await decoded(
      await world.call('POST', `${world.root}/grants`, world.ownerCookie, {
        roleId: role.id,
        roleRevision: role.revision,
        subjectRevision: source.revision,
        subject: { kind: 'source', sourceId: source.id },
        scope: { kind: 'workspace' },
      }),
      WorkspaceAccessGrant,
    );
    expect(grant.role.name).toBe('Audit readers');
    expect(grant.subject.kind).toBe('source');
    if (grant.subject.kind === 'source') expect(grant.subject.user.id).toBe(world.person.userId);
    const me = await decoded(await world.call('GET', '/api/me', world.personCookie), MeResponse);
    expect(
      me.memberships.find((entry) => entry.workspace.id === world.workspaceId)
        ?.workspaceCapabilities,
    ).toEqual(['audit.read']);
    expect(
      (await world.call('GET', `/api/workspaces/${world.workspaceId}/audit`, world.personCookie))
        .status,
    ).toBe(200);
    const download = await world.call(
      'GET',
      `/api/workspaces/${world.workspaceId}/audit/export?format=ndjson`,
      world.personCookie,
    );
    expect(download.status).toBe(200);
    expect(
      (
        await world.call('POST', `${world.root}/roles`, world.personCookie, {
          name: 'Not permitted',
          capabilities: ['members.invite'],
        })
      ).status,
    ).toBe(403);
    const revoked = await decoded(
      await world.call('POST', `${target}/sources/${source.id}/revoke`, world.ownerCookie, {
        revision: source.revision,
      }),
      WorkspaceMemberAccess,
    );
    expect(revoked.state).toBe('inactive');
    let downloadRefusal: ErrorCode | null = null;
    try {
      await download.text();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      downloadRefusal = error.body.code;
    }
    expect(downloadRefusal).toBe('WORKSPACE_NOT_FOUND');
    const after = await decoded(await world.call('GET', '/api/me', world.personCookie), MeResponse);
    expect(after.memberships.some((entry) => entry.workspace.id === world.workspaceId)).toBe(false);
    expect(
      (await world.call('GET', `/api/workspaces/${world.workspaceId}/audit`, world.personCookie))
        .status,
    ).toBe(404);
  });

  test('group changes, offboarding and explicit readmission use observed native state without promoting a builtin role', async () => {
    const world = await setup();
    const target = `${world.root}/people/${world.person.userId}`;
    const access = await decoded(
      await world.call('GET', target, world.ownerCookie),
      WorkspaceMemberAccess,
    );
    const source = access.sources.find((entry) => entry.kind === 'manual');
    if (source === undefined) throw new Error('Missing manual source');
    const group = await decoded(
      await world.call('POST', `${world.root}/groups`, world.ownerCookie, { name: 'Finance' }),
      WorkspaceAccessGroup,
    );
    const changed = await decoded(
      await world.call('PATCH', `${world.root}/groups/${group.id}/members`, world.ownerCookie, {
        revision: group.revision,
        addSourceIds: [source.id],
      }),
      WorkspaceAccessGroup,
    );
    expect(changed.memberCount).toBe(1);
    for (const path of [
      `${world.root}/groups?limit=1`,
      `${world.root}/groups/${group.id}/candidates?limit=1`,
    ])
      expect((await world.call('GET', path, world.ownerCookie)).status).toBe(200);
    const members = await decoded(
      await world.call(
        'GET',
        `${world.root}/groups/${group.id}/members?limit=1`,
        world.ownerCookie,
      ),
      WorkspaceAccessGroupMemberPage,
    );
    expect(members.data.map((entry) => [entry.user.id, entry.source.id])).toEqual([
      [world.person.userId, source.id],
    ]);
    const current = await decoded(
      await world.call('GET', target, world.ownerCookie),
      WorkspaceMemberAccess,
    );
    expect(
      (
        await world.call('POST', `${target}/offboarding`, world.ownerCookie, {
          revision: current.revision,
          confirm: false,
        })
      ).status,
    ).toBe(400);
    const preview = await decoded(
      await world.call('POST', `${target}/offboarding/preview`, world.ownerCookie, {
        revision: current.revision,
      }),
      WorkspaceOffboardingPreview,
    );
    expect(preview.canOffboard).toBe(true);
    const offboarded = await decoded(
      await world.call('POST', `${target}/offboarding`, world.ownerCookie, {
        revision: current.revision,
        confirm: true,
      }),
      WorkspaceMemberAccess,
    );
    expect(offboarded.state).toBe('offboarded');
    expect(offboarded.role).toBeNull();
    expect(
      (
        await world.call('POST', `${target}/readmission`, world.ownerCookie, {
          revision: current.revision,
          confirm: true,
        })
      ).status,
    ).toBe(409);
    const admitted = await decoded(
      await world.call('POST', `${target}/readmission`, world.ownerCookie, {
        revision: offboarded.revision,
        confirm: true,
      }),
      WorkspaceMemberAccess,
    );
    expect(admitted.state).toBe('active');
    expect(admitted.role).toBe('member');
    expect((await world.call('GET', '/api/me', world.personCookie)).status).toBe(200);
    const ownAccess = await decoded(
      await world.call('GET', `${world.root}/people/${world.owner.userId}`, world.ownerCookie),
      WorkspaceMemberAccess,
    );
    const ownPreview = await decoded(
      await world.call(
        'POST',
        `${world.root}/people/${world.owner.userId}/offboarding/preview`,
        world.ownerCookie,
        { revision: ownAccess.revision },
      ),
      WorkspaceOffboardingPreview,
    );
    expect(ownPreview.canOffboard).toBe(false);
    expect(ownPreview.reason).toBe('last_owner');
    expect(
      (
        await world.call(
          'POST',
          `${world.root}/people/${world.owner.userId}/offboarding`,
          world.ownerCookie,
          { revision: ownAccess.revision, confirm: true },
        )
      ).status,
    ).toBe(409);
  });

  test('cross-workspace inventories and malformed or stale administration requests retain the HTTP boundary', async () => {
    const world = await setup();
    for (const suffix of ['/people', '/roles', '/groups', '/grants']) {
      expect((await world.call('GET', `${world.root}${suffix}`, world.outsiderCookie)).status).toBe(
        404,
      );
      expect((await world.call('GET', `${world.root}${suffix}`, world.personCookie)).status).toBe(
        403,
      );
    }
    expect(
      (
        await world.call(
          'GET',
          `/api/workspaces/${world.workspaceId}/directories`,
          world.personCookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await world.call(
          'GET',
          `/api/workspaces/${world.workspaceId}/directories`,
          world.outsiderCookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (await world.call('GET', `${world.root}/groups/not-a-uuid/members`, world.ownerCookie))
        .status,
    ).toBe(404);
    expect(
      (
        await world.call(
          'GET',
          `${world.root}/grants?sourceId=${crypto.randomUUID()}&groupId=${crypto.randomUUID()}`,
          world.ownerCookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await world.call('POST', `${world.root}/roles`, world.ownerCookie, {
          name: 'Forged',
          capabilities: ['owner'],
        })
      ).status,
    ).toBe(400);
    const role = await decoded(
      await world.call('POST', `${world.root}/roles`, world.ownerCookie, {
        name: 'Stale fixture',
        capabilities: ['audit.read'],
      }),
      WorkspaceAccessRole,
    );
    const updated = await world.call('PATCH', `${world.root}/roles/${role.id}`, world.ownerCookie, {
      revision: role.revision,
      name: 'Current name',
    });
    expect(updated.status).toBe(200);
    expect(
      (
        await world.call('PATCH', `${world.root}/roles/${role.id}`, world.ownerCookie, {
          revision: role.revision,
          name: 'Lost edit',
        })
      ).status,
    ).toBe(409);
  });
});
