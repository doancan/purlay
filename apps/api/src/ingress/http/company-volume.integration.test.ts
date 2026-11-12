/** Tenfold company/provider/member populations keep live company requests bounded and isolated. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { withoutRequest } from '../../platform/logging';
import { CLIENT_ADDRESS_HEADER } from '../../modules/auth/better-auth';
import { createCompanyConnection } from '../../modules/workspaces/identity/connections';
import { aTestAuth } from '../../testing/signed-in';
import { aUserRow } from '../../testing/users';
import { testDependencies } from '../../testing/doubles';
import { signInCompanyNative, enableCompanyNative } from '../../testing/company-native-auth';
import { OIDC_STUB_CREDENTIALS } from '../../testing/oidc-stub';
import { measureCompanySocketLatency } from '../../testing/company-volume-sockets';
import { createApp } from './app';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

type World = Awaited<ReturnType<typeof signInCompanyNative>>;

const growCompany = async (world: World, clientAddress: string): Promise<void> => {
  const workspaceId = world.fixture.actor.context.workspaceId;
  const people = await Promise.all(
    Array.from(
      { length: 18 },
      async (_, index) => await aUserRow(clone.db, `volume-employee-${String(index)}`),
    ),
  );
  await clone.db
    .insertInto('workspace_members')
    .values(
      people.map((person) => ({
        workspace_id: workspaceId,
        user_id: person.userId,
        role: 'member' as const,
      })),
    )
    .execute();
  // Administrators of different companies have different client addresses. Keep the real rate limits:
  // the population seed must not impersonate hundreds of sign-ins from one administrator's address.
  const configured = {
    ...world,
    auth: {
      ...world.auth,
      handler: async (request: Request): Promise<Response> => {
        const headers = new Headers(request.headers);
        headers.set(CLIENT_ADDRESS_HEADER, clientAddress);
        return await world.auth.handler(new Request(request, { headers }));
      },
    },
  };
  // Every extra provider passes the actual native test before it can be enabled; SQL cannot fake readiness.
  for (let index = 1; index < 10; index++) {
    const connection = await createCompanyConnection(
      world.fixture.dependencies,
      world.fixture.actor,
      {
        domainId: world.connection.domainId,
        name: `Office ${String(index)}`,
        issuer: world.idp.issuer(),
        ...OIDC_STUB_CREDENTIALS,
      },
    );
    await enableCompanyNative({ ...configured, connection });
  }
};

describe('integration: company identity volume', () => {
  test('1→10 companies, 1→10 tested providers and 2→20 employees per company add no per-row request queries', async () => {
    const first = await withoutRequest(async () => await signInCompanyNative(clone.db));
    let queries = 0;
    const database = clone.db.withPlugin({
      transformQuery: ({ node }) => {
        queries++;
        return node;
      },
      transformResult: ({ result }) => Promise.resolve(result),
    });
    const auth = aTestAuth(database, {
      companyIdentity: { cipher: first.fixture.dependencies.cipher, fetch: first.idp.fetch },
    });
    const app = createApp(testDependencies({ database, auth, clock: systemClock }));
    const workspaceId = first.fixture.member.context.workspaceId;
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    const paths = [
      '/api/me',
      '/api/workspaces',
      `/api/workspaces/${workspaceId}/channels`,
      `/api/workspaces/${workspaceId}/members?limit=100`,
      `/api/workspaces/${workspaceId}/company-identities`,
      `/auth/company-options?workspace=${workspace.slug}`,
    ];
    const request = async (path: string, cookie = first.cookie): Promise<Response> =>
      await app.handle(new Request(`https://purlay.test${path}`, { headers: { cookie } }));
    const measure = async (): Promise<readonly number[]> => {
      const counts: number[] = [];
      for (const path of paths) {
        queries = 0;
        const response = await request(path);
        expect(response.status, path).toBe(200);
        await response.arrayBuffer();
        counts.push(queries);
      }
      return counts;
    };
    // Let the first touch update session activity before measuring the steady request shape.
    await measure();
    const baseline = await measure();
    const companies: World[] = [first];
    await withoutRequest(async () => {
      for (let index = 1; index < 10; index++) companies.push(await signInCompanyNative(clone.db));
      for (const [index, company] of companies.entries())
        await growCompany(company, `198.51.100.${String(index + 1)}`);
    });
    expect(
      await clone.db
        .selectFrom('workspace_identity_connections')
        .select('id')
        .where('enabled', '=', true)
        .execute(),
    ).toHaveLength(100);
    expect(await clone.db.selectFrom('workspace_members').select('user_id').execute()).toHaveLength(
      200,
    );
    // A positive native membership in another tenant makes every exclusion below an authority check.
    await clone.db
      .insertInto('workspace_members')
      .values(
        companies.map((company, index) => {
          const neighbour = companies[(index + 1) % companies.length];
          if (neighbour === undefined) throw new Error('Missing neighbouring company');
          return {
            workspace_id: neighbour.fixture.member.context.workspaceId,
            user_id: company.companySession.userId,
            role: 'member' as const,
          };
        }),
      )
      .execute();
    expect(await measure()).toEqual(baseline);
    const listed = await request(`/auth/company-options?workspace=${workspace.slug}`);
    const options = (await listed.json()) as { connections: { id: string }[] };
    expect(options.connections).toHaveLength(10);
    expect(new Set(options.connections.map((connection) => connection.id)).size).toBe(10);
    const times: number[] = [];
    // Ten actual native company sessions stay active concurrently, each reading only its own workspace.
    const chat = await measureCompanySocketLatency({
      app,
      database: clone.db,
      world: first,
      during: async () => {
        const externalCalls = companies.map((company) => company.idp.calls.urls.length);
        await Promise.all(
          companies.map(async (company) => {
            for (let index = 0; index < 60; index++) {
              const started = performance.now();
              const response = await request('/api/workspaces', company.cookie);
              expect(response.status).toBe(200);
              const body = JSON.stringify(await response.json());
              const ownId = company.fixture.member.context.workspaceId;
              expect(body).toContain(ownId);
              for (const other of companies)
                if (other !== company)
                  expect(body).not.toContain(other.fixture.member.context.workspaceId);
              times.push(performance.now() - started);
              await Bun.sleep(125);
            }
          }),
        );
        expect(companies.map((company) => company.idp.calls.urls.length)).toEqual(externalCalls);
      },
    });
    expect(times).toHaveLength(600);
    times.sort((left, right) => left - right);
    // Diagnostic evidence, not an invented replacement for the existing independent-process latency/RSS budgets.
    console.info(
      JSON.stringify({
        companyVolume: {
          companies: 10,
          providers: 100,
          employees: 200,
          memberships: 210,
          activeCompanySessions: 10,
        },
        requestQueries: baseline,
        concurrentReads: 600,
        concurrentReadP95Ms: times[569],
        chat,
      }),
    );
  }, 60_000);
});
