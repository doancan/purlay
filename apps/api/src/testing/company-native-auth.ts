/** Real native company OAuth fixture; only the external IdP is replaced. @needs-modules chat */
import { expect } from 'bun:test';
import type { Executor } from '@purlay/db';
import { AUTH_BASE_PATH } from '@purlay/types';
import { systemClock } from '../platform/clock';
import { SESSION_COOKIE, COMPANY_SESSION_COOKIE } from '../platform/cookies';
import { sessionFromHeaders, type SessionOwner } from '../modules/auth/sessions';
import { companyIdentityFixture } from './company-identity';
import { aSession, aTestAuth } from './signed-in';
import { anOidcStub, OIDC_STUB_CREDENTIALS } from './oidc-stub';
import { heldTransaction } from '../modules/auth/sign-up-transaction';
import { CLIENT_ADDRESS_HEADER } from '../modules/auth/better-auth';
import { createCompanyDomain, verifyCompanyDomain } from '../modules/workspaces/identity/domains';
import {
  createCompanyConnection,
  listCompanyConnections,
  setCompanyConnectionEnabled,
} from '../modules/workspaces/identity/connections';
export const setupCompanyNative = async (
  database: Executor,
): Promise<{
  readonly fixture: Awaited<ReturnType<typeof companyIdentityFixture>>;
  readonly idp: Awaited<ReturnType<typeof anOidcStub>>;
  readonly auth: ReturnType<typeof aTestAuth>;
  readonly network: { afterToken?: () => Promise<void> };
  readonly connection: Awaited<ReturnType<typeof createCompanyConnection>>;
  readonly ownerCookie: string;
  readonly memberCookie: string;
}> => {
  const original = await companyIdentityFixture(database);
  const fixture = { ...original, dependencies: { ...original.dependencies, clock: systemClock } };
  const owner = await aSession(database, systemClock, fixture.actor.context.userId);
  const member = await aSession(database, systemClock, fixture.member.context.userId);
  fixture.actor = { ...fixture.actor, sessionId: owner.sessionId };
  fixture.member = { ...fixture.member, sessionId: member.sessionId };
  const idp = await anOidcStub({
    sub: 'company-administrator',
    email: 'provider-admin@example.test',
  });
  const network: { afterToken?: () => Promise<void> } = {};
  const auth = aTestAuth(database, {
    clock: systemClock,
    companyIdentity: {
      cipher: fixture.dependencies.cipher,
      fetch: async (...args) => {
        expect(heldTransaction()).toBeUndefined();
        const response = await idp.fetch(...args);
        if (args[0].endsWith('/token') && network.afterToken !== undefined) {
          const perform = network.afterToken;
          delete network.afterToken;
          await perform();
        }
        return response;
      },
    },
  });
  const pending = await createCompanyDomain(fixture.dependencies, fixture.actor, 'company.example');
  const domain = await verifyCompanyDomain(
    fixture.dependencies,
    fixture.actor,
    pending.id,
    pending.revision,
    () => Promise.resolve([[pending.dnsRecord?.value ?? '']]),
  );
  const connection = await createCompanyConnection(fixture.dependencies, fixture.actor, {
    domainId: domain.id,
    name: 'Office',
    issuer: idp.issuer(),
    ...OIDC_STUB_CREDENTIALS,
  });
  return {
    fixture,
    idp,
    auth,
    network,
    connection,
    ownerCookie: `${SESSION_COOKIE}=${owner.token}`,
    memberCookie: `${SESSION_COOKIE}=${member.token}`,
  };
};

export const companyNativeHeaders = (cookie: string): Headers =>
  new Headers({
    cookie,
    origin: 'https://purlay.test',
    'content-type': 'application/json',
    [CLIENT_ADDRESS_HEADER]: '127.0.0.1',
  });

export const beginCompanyNative = async (
  configured: Awaited<ReturnType<typeof setupCompanyNative>>,
  body: unknown,
  cookie: string,
  login = false,
): Promise<{ readonly callback: string; readonly cookies: string }> => {
  const start = await configured.auth.handler(
    new Request(`https://purlay.test${AUTH_BASE_PATH}/company/${login ? 'sign-in' : 'start'}`, {
      method: 'POST',
      headers: companyNativeHeaders(cookie),
      body: JSON.stringify(body),
    }),
  );
  expect(start.status).toBe(200);
  const data: unknown = await start.json();
  if (typeof data !== 'object' || data === null || !('url' in data) || typeof data.url !== 'string')
    throw new Error('Missing company authorization URL');
  const granted = configured.idp.authorize(data.url);
  const callback = new URL(granted.redirectUri);
  callback.searchParams.set('code', granted.code);
  callback.searchParams.set('state', granted.state);
  const stateCookies = start.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '')
    .join('; ');
  return {
    callback: callback.toString(),
    cookies: [cookie, stateCookies].filter(Boolean).join('; '),
  };
};

export const dispatchCompanyNative = async (
  configured: Awaited<ReturnType<typeof setupCompanyNative>>,
  round: Awaited<ReturnType<typeof beginCompanyNative>>,
): Promise<Response> =>
  await configured.auth.handler(
    new Request(round.callback, { headers: companyNativeHeaders(round.cookies) }),
  );

export const roundtripCompanyNative = async (
  configured: Awaited<ReturnType<typeof setupCompanyNative>>,
  body: unknown,
  cookie: string,
  login = false,
): Promise<Response> =>
  await dispatchCompanyNative(
    configured,
    await beginCompanyNative(configured, body, cookie, login),
  );

export const enableCompanyNative = async (
  configured: Awaited<ReturnType<typeof setupCompanyNative>>,
): Promise<Awaited<ReturnType<typeof setCompanyConnectionEnabled>>> => {
  const { fixture, connection } = configured;
  expect(
    (
      await roundtripCompanyNative(
        configured,
        {
          workspaceId: fixture.actor.context.workspaceId,
          connectionId: connection.id,
          revision: connection.revision,
          intent: 'test',
        },
        configured.ownerCookie,
      )
    ).status,
  ).toBe(302);
  const tested = (await listCompanyConnections(fixture.dependencies, fixture.actor)).data.find(
    (entry) => entry.id === connection.id,
  );
  if (tested === undefined) throw new Error('Missing tested company connection');
  return await setCompanyConnectionEnabled(
    fixture.dependencies,
    fixture.actor,
    connection.id,
    tested.revision,
    true,
  );
};

/** Completes a tested provider, explicit enrollment and anonymous company sign-in through the real native handler. */
export const signInCompanyNative = async (
  database: Executor,
): Promise<
  Awaited<ReturnType<typeof setupCompanyNative>> & {
    readonly cookie: string;
    readonly companySession: SessionOwner;
  }
> => {
  const configured = await setupCompanyNative(database);
  const { fixture, connection } = configured;
  const enabled = await enableCompanyNative(configured);
  configured.idp.person = { sub: 'company-scoped-employee', email: 'employee@company.example' };
  expect(
    (
      await roundtripCompanyNative(
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
  const workspace = await database
    .selectFrom('workspaces')
    .select('slug')
    .where('id', '=', fixture.member.context.workspaceId)
    .executeTakeFirstOrThrow();
  const response = await roundtripCompanyNative(
    configured,
    { workspace: workspace.slug, connectionId: connection.id },
    '',
    true,
  );
  expect(response.status).toBe(302);
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${COMPANY_SESSION_COOKIE}=`))
    ?.split(';')[0];
  if (cookie === undefined) throw new Error('Missing company session cookie');
  const companySession = await sessionFromHeaders(configured.auth, companyNativeHeaders(cookie));
  if (companySession?.companyWorkspaceId !== fixture.member.context.workspaceId)
    throw new Error('Missing company session authority');
  return { ...configured, cookie, companySession };
};
