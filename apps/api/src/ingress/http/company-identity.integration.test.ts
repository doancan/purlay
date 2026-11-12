/** The real API boundary authenticates, validates and scopes company settings without returning a provider credential. */
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
  CompanyIdentityDomain,
  CompanyIdentityDomainPage,
  CompanyIdentityConnection,
  CompanySignInOptions,
  MyCompanyIdentityPage,
} from '@purlay/types/workspace-identity';
import { systemClock } from '../../platform/clock';
import { testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { signInCompanyNative } from '../../testing/company-native-auth';
import {
  listCompanyConnections,
  setCompanyConnectionEnabled,
} from '../../modules/workspaces/identity/connections';
import { SESSION_COOKIE } from '../../platform/cookies';
import type { CompanyTxtLookup } from '../../modules/workspaces/identity/domains';
import { createApp } from './app';

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
  if (!Value.Check(schema, body))
    throw new Error(`Invalid company response, status ${String(response.status)}`);
  return body;
};

const setup = async (
  lookup: CompanyTxtLookup = () => Promise.resolve([]),
): Promise<{
  readonly app: ReturnType<typeof createApp>;
  readonly workspaceId: string;
  readonly owner: string;
  readonly member: string;
  readonly ownerSessionId: string;
}> => {
  const room = await aRoom(clone.db, ['identity-http-owner', 'identity-http-member']);
  const owner = await aSession(
    clone.db,
    systemClock,
    room.members['identity-http-owner']?.userId ?? '',
  );
  const member = await aSession(
    clone.db,
    systemClock,
    room.members['identity-http-member']?.userId ?? '',
  );
  return {
    app: createApp(
      testDependencies({ database: clone.db, clock: systemClock, companyTxtLookup: lookup }),
    ),
    workspaceId: room.workspaceId,
    owner: `${SESSION_COOKIE}=${owner.token}`,
    member: `${SESSION_COOKIE}=${member.token}`,
    ownerSessionId: owner.sessionId,
  };
};

const call = async (
  app: ReturnType<typeof createApp>,
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

describe('integration: HTTP company identity', () => {
  test('renewing DNS proof through HTTP invalidates the previous revision without creating a provider', async () => {
    const world = await setup();
    const root = `/api/workspaces/${world.workspaceId}/identity`;
    const pending = await decoded(
      await call(world.app, 'POST', `${root}/domains`, world.owner, { domain: 'renew.example' }),
      CompanyIdentityDomain,
    );
    const renewed = await decoded(
      await call(world.app, 'POST', `${root}/domains/${pending.id}/renew`, world.owner, {
        revision: pending.revision,
      }),
      CompanyIdentityDomain,
    );
    expect(renewed.revision).not.toBe(pending.revision);
    expect(renewed.dnsRecord?.value).not.toBe(pending.dnsRecord?.value);
    expect(
      (
        await call(world.app, 'POST', `${root}/domains/${pending.id}/verify`, world.owner, {
          revision: pending.revision,
        })
      ).status,
    ).toBe(409);
    expect(await (await call(world.app, 'GET', `${root}/connections`, world.owner)).json()).toEqual(
      { data: [], nextCursor: null },
    );
  });

  test('anonymous lookup exposes only an exact workspace’s tested, enabled provider names', async () => {
    const world = await signInCompanyNative(clone.db);
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', world.fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    const lookup = async (query: string): Promise<Response> =>
      await call(app, 'GET', `/auth/company-options?${query}`, '');
    expect(
      await decoded(await lookup(`workspace=${workspace.slug}`), CompanySignInOptions),
    ).toEqual({
      workspace: workspace.slug,
      connections: [{ id: world.connection.id, name: world.connection.name }],
    });
    const absent = `absent-${crypto.randomUUID()}`;
    expect(await decoded(await lookup(`workspace=${absent}`), CompanySignInOptions)).toEqual({
      workspace: absent,
      connections: [],
    });
    expect((await lookup('workspace=INVALID')).status).toBe(400);
    expect((await lookup('')).status).toBe(400);
    const current = (await listCompanyConnections(world.fixture.dependencies, world.fixture.actor))
      .data[0];
    if (current === undefined) throw new Error('Missing tested company connection');
    await setCompanyConnectionEnabled(
      world.fixture.dependencies,
      world.fixture.actor,
      current.id,
      current.revision,
      false,
    );
    expect(
      await decoded(await lookup(`workspace=${workspace.slug}`), CompanySignInOptions),
    ).toEqual({ workspace: workspace.slug, connections: [] });
  });

  test('the own-identity unlink endpoint revokes the linked company source without ending independent sign-in', async () => {
    const world = await signInCompanyNative(clone.db);
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    const path = `/api/workspaces/${world.fixture.member.context.workspaceId}/company-identities`;
    const page = await decoded(
      await call(app, 'GET', path, world.memberCookie),
      MyCompanyIdentityPage,
    );
    const binding = page.data.find(
      (entry) => entry.connectionId === world.connection.id,
    )?.bindingId;
    if (binding == null) throw new Error('Missing actual enrolled identity');
    expect(
      (
        await call(app, 'DELETE', `${path}/${world.connection.id}`, world.memberCookie, {
          bindingId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(app, 'DELETE', `${path}/${world.connection.id}`, world.memberCookie, {
          bindingId: binding,
        })
      ).status,
    ).toBe(204);
    expect(
      (await decoded(await call(app, 'GET', path, world.memberCookie), MyCompanyIdentityPage))
        .data[0]?.bindingId,
    ).toBeNull();
    expect((await call(app, 'GET', '/api/me', world.cookie)).status).toBe(401);
    expect((await call(app, 'GET', '/api/me', world.memberCookie)).status).toBe(200);
  });

  test('domain proof and sealed configuration CRUD are exposed through the real API contract', async () => {
    const records = new Map<string, readonly string[]>();
    const world = await setup((name) => Promise.resolve([records.get(name) ?? []]));
    const root = `/api/workspaces/${world.workspaceId}/identity`;
    const created = await call(world.app, 'POST', `${root}/domains`, world.owner, {
      domain: ' COMPANY.Example. ',
    });
    expect(created.status).toBe(201);
    const pending = await decoded(created, CompanyIdentityDomain);
    expect(
      (
        await decoded(
          await call(world.app, 'GET', `${root}/domains`, world.owner),
          CompanyIdentityDomainPage,
        )
      ).data,
    ).toEqual([pending]);
    expect(
      (
        await call(world.app, 'POST', `${root}/domains/${pending.id}/verify`, world.owner, {
          revision: pending.revision,
        })
      ).status,
    ).toBe(409);
    const proof = pending.dnsRecord;
    if (proof === null) throw new Error('Missing TXT proof');
    records.set(proof.name, [proof.value]);
    const verified = await decoded(
      await call(world.app, 'POST', `${root}/domains/${pending.id}/verify`, world.owner, {
        revision: pending.revision,
      }),
      CompanyIdentityDomain,
    );
    expect(verified.state).toBe('verified');
    expect(verified.dnsRecord).toBeNull();
    const made = await decoded(
      await call(world.app, 'POST', `${root}/connections`, world.owner, {
        name: 'Office',
        issuer: 'https://idp.example',
        domainId: verified.id,
        clientId: 'office-client',
        clientSecret: 'fixture-write-only-secret',
      }),
      CompanyIdentityConnection,
    );
    expect(made.secretConfigured).toBe(true);
    expect(made.ready).toBe(false);
    expect(made.enabled).toBe(false);
    expect(JSON.stringify(made)).not.toContain('fixture-write-only-secret');
    expect(
      (
        await call(world.app, 'PUT', `${root}/connections/${made.id}/enabled`, world.owner, {
          revision: made.revision,
          enabled: true,
        })
      ).status,
    ).toBe(409);
    const before = await clone.db
      .selectFrom('workspace_identity_connections')
      .select('client_secret_encrypted')
      .where('id', '=', made.id)
      .executeTakeFirstOrThrow();
    const changed = await decoded(
      await call(world.app, 'PATCH', `${root}/connections/${made.id}`, world.owner, {
        revision: made.revision,
        name: 'Renamed office',
      }),
      CompanyIdentityConnection,
    );
    expect(
      await clone.db
        .selectFrom('workspace_identity_connections')
        .select('client_secret_encrypted')
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      (
        await call(world.app, 'PATCH', `${root}/connections/${made.id}`, world.owner, {
          revision: made.revision,
          name: 'stale',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(world.app, 'DELETE', `${root}/connections/${made.id}`, world.owner, {
          revision: changed.revision,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call(world.app, 'DELETE', `${root}/domains/${verified.id}`, world.owner, {
          revision: verified.revision,
        })
      ).status,
    ).toBe(204);
    const mine = await decoded(
      await call(
        world.app,
        'GET',
        `/api/workspaces/${world.workspaceId}/company-identities`,
        world.member,
      ),
      MyCompanyIdentityPage,
    );
    expect(mine.data).toEqual([]);
  });

  test('signed-out users, other workspaces, members and malformed identities cannot read administrative settings', async () => {
    const world = await setup();
    const other = await setup();
    const root = `/api/workspaces/${world.workspaceId}/identity`;
    expect((await call(world.app, 'GET', `${root}/domains`, '')).status).toBe(401);
    expect((await call(world.app, 'GET', `${root}/domains`, world.member)).status).toBe(403);
    expect((await call(world.app, 'GET', `${root}/domains`, other.owner)).status).toBe(404);
    expect(
      (
        await call(world.app, 'DELETE', `${root}/domains/not-a-uuid`, world.owner, {
          revision: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404);
    const refused = await call(world.app, 'POST', `${root}/domains`, world.owner, {
      domain: 'company.example',
      verified: true,
      role: 'owner',
    });
    expect(refused.status).toBe(400);
    expect(
      await clone.db
        .selectFrom('workspace_identity_domains')
        .select('id')
        .where('workspace_id', '=', world.workspaceId)
        .execute(),
    ).toEqual([]);
  });

  test('session revocation committed during DNS is a real API401 and leaves the proof pending', async () => {
    let sessionId = '';
    let value = '';
    const world = await setup(async () => {
      await clone.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
      return [[value]];
    });
    sessionId = world.ownerSessionId;
    const root = `/api/workspaces/${world.workspaceId}/identity/domains`;
    const pending = await decoded(
      await call(world.app, 'POST', root, world.owner, { domain: 'company.example' }),
      CompanyIdentityDomain,
    );
    value = pending.dnsRecord?.value ?? '';
    const answer = await call(world.app, 'POST', `${root}/${pending.id}/verify`, world.owner, {
      revision: pending.revision,
    });
    expect(answer.status).toBe(401);
    const row = await clone.db
      .selectFrom('workspace_identity_domains')
      .select(['revision', 'verified_at'])
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ revision: pending.revision, verified_at: null });
  });
});
