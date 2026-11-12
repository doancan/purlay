/** Real client decoding and request construction at the HTTP/native-auth boundary. */
import { expect, test } from 'bun:test';
import type {
  CompanyIdentityDomain,
  CompanyIdentityConnection,
} from '@purlay/types/workspace-identity';
import { createApi } from './api';
import { createHttp, type FetchPort } from './http';
import { ApiError, LibraryFailure } from './errors';

const ID = '00000000-0000-4000-8000-0000000000a1';
const REVISION = '00000000-0000-4000-8000-0000000000a2';
const WHEN = '2026-11-12T09:00:00.000Z';
const domain: CompanyIdentityDomain = {
  id: ID,
  revision: REVISION,
  domain: 'company.example',
  state: 'verified',
  dnsRecord: null,
  challengeExpiresAt: WHEN,
  verifiedAt: WHEN,
  createdAt: WHEN,
};
const connection: CompanyIdentityConnection = {
  id: ID,
  revision: REVISION,
  domainId: ID,
  name: 'Office',
  issuer: 'https://identity.example',
  clientId: 'client',
  secretConfigured: true,
  ready: false,
  enabled: false,
  testedAt: null,
  createdAt: WHEN,
  updatedAt: WHEN,
};

const bodyOf = (init: RequestInit | undefined): unknown => {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as unknown;
};

const setup = (
  reply: () => Response,
): {
  readonly api: ReturnType<typeof createApi>;
  readonly seen: { url: string; init: RequestInit }[];
} => {
  const seen: { url: string; init: RequestInit }[] = [];
  const get: FetchPort = (url, init) => {
    seen.push({ url, init });
    return Promise.resolve(reply());
  };
  return { api: createApi(createHttp(get)), seen };
};

test('domain proof requests carry observed revisions and leave credentials in JSON writes only', async () => {
  const { api, seen } = setup(() => Response.json(domain));
  await api.verifyCompanyDomain('workspace/with space', ID, REVISION);
  expect(seen[0]?.url).toBe(
    `/api/workspaces/workspace%2Fwith%20space/identity/domains/${ID}/verify`,
  );
  expect(seen[0]?.init.method).toBe('POST');
  expect(bodyOf(seen[0]?.init)).toEqual({ revision: REVISION });
  expect(seen[0]?.init.credentials).toBe('same-origin');
  await api.renewCompanyDomain(ID, ID, REVISION);
  expect(seen[1]?.url).toBe(`/api/workspaces/${ID}/identity/domains/${ID}/renew`);
});

test('connection edits preserve omitted secrets and enabled changes are revision fenced', async () => {
  const { api, seen } = setup(() => Response.json(connection));
  await api.updateCompanyConnection(ID, ID, { revision: REVISION, name: 'Renamed' });
  expect(seen[0]?.init.method).toBe('PATCH');
  expect(bodyOf(seen[0]?.init)).toEqual({ revision: REVISION, name: 'Renamed' });
  await api.createCompanyConnection(ID, {
    domainId: ID,
    name: 'Office',
    issuer: connection.issuer,
    clientId: 'client',
    clientSecret: 'write-only-secret',
  });
  expect(seen[1]?.url).not.toContain('write-only-secret');
  expect(bodyOf(seen[1]?.init)).toMatchObject({ clientSecret: 'write-only-secret' });
  await api.setCompanyConnectionEnabled(ID, ID, REVISION, true);
  expect(seen[2]?.url).toBe(`/api/workspaces/${ID}/identity/connections/${ID}/enabled`);
  expect(bodyOf(seen[2]?.init)).toEqual({ revision: REVISION, enabled: true });
});

test('own identity pagination and unlink use the observed binding, not a client-selected person', async () => {
  let deleting = false;
  const { api, seen } = setup(() =>
    deleting
      ? new Response(null, { status: 204 })
      : Response.json({
          data: [
            {
              connectionId: ID,
              revision: REVISION,
              name: 'Office',
              available: true,
              bindingId: ID,
              linkedAt: WHEN,
            },
          ],
          nextCursor: null,
        }),
  );
  const controller = new AbortController();
  const page = await api.myCompanyIdentities(ID, { before: REVISION, limit: 1 }, controller.signal);
  expect(page.data[0]?.revision).toBe(REVISION);
  expect(seen[0]?.url).toContain(`before=${REVISION}`);
  expect(seen[0]?.url).toContain('limit=1');
  controller.abort();
  expect(seen[0]?.init.signal?.aborted).toBe(true);
  deleting = true;
  await api.unlinkCompanyIdentity(ID, ID, REVISION);
  expect(seen[1]?.init.method).toBe('DELETE');
  expect(bodyOf(seen[1]?.init)).toEqual({ bindingId: REVISION });
});

test('public lookup is exact and OAuth starts use the native library protocol', async () => {
  let native = false;
  const { api, seen } = setup(() =>
    Response.json(
      native
        ? { url: 'https://identity.example/authorize' }
        : { workspace: 'acme', connections: [{ id: ID, name: 'Office' }] },
    ),
  );
  await api.companySignInOptions('acme');
  expect(seen[0]?.url).toBe('/auth/company-options?workspace=acme');
  native = true;
  await api.startCompanyIdentity({
    workspaceId: ID,
    connectionId: ID,
    revision: REVISION,
    intent: 'link',
  });
  expect(seen[1]?.url).toBe('/auth/company/start');
  expect(bodyOf(seen[1]?.init)).toEqual({
    workspaceId: ID,
    connectionId: ID,
    revision: REVISION,
    intent: 'link',
  });
  await api.signInWithCompany({ workspace: 'acme', connectionId: ID });
  expect(seen[2]?.url).toBe('/auth/company/sign-in');
  expect(bodyOf(seen[2]?.init)).toEqual({ workspace: 'acme', connectionId: ID });
});

test('native refusals stay typed and an unsafe returned provider URL is never accepted', async () => {
  let malformed = false;
  const { api } = setup(() =>
    malformed
      ? Response.json({ url: 'javascript:alert(1)' })
      : Response.json({ code: 'UNAUTHORIZED', message: 'Sign in first.' }, { status: 401 }),
  );
  let failure: unknown;
  try {
    await api.signInWithCompany({ workspace: 'acme', connectionId: ID });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LibraryFailure);
  malformed = true;
  failure = undefined;
  try {
    await api.signInWithCompany({ workspace: 'acme', connectionId: ID });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ApiError);
  if (failure instanceof ApiError) expect(failure.code).toBe('MALFORMED');
});

test('catalogue reads and destructive requests retain their signal and observed revision', async () => {
  let response = Response.json({ data: [domain], nextCursor: null });
  const { api, seen } = setup(() => response.clone());
  const controller = new AbortController();
  expect((await api.companyDomains(ID, controller.signal)).data).toEqual([domain]);
  expect(seen[0]?.init.signal).toBe(controller.signal);
  response = Response.json(domain);
  expect(await api.createCompanyDomain(ID, { domain: domain.domain })).toEqual(domain);
  expect(seen[1]?.init.method).toBe('POST');
  expect(bodyOf(seen[1]?.init)).toEqual({ domain: domain.domain });
  response = Response.json({ data: [connection], nextCursor: null });
  expect((await api.companyConnections(ID, controller.signal)).data).toEqual([connection]);
  expect(seen[2]?.url).toBe(`/api/workspaces/${ID}/identity/connections`);
  expect(seen[2]?.init.signal).toBe(controller.signal);
  response = new Response(null, { status: 204 });
  await api.revokeCompanyDomain(ID, ID, REVISION);
  await api.deleteCompanyConnection(ID, ID, REVISION);
  for (const [request, resource] of [
    [seen[3], 'domains'],
    [seen[4], 'connections'],
  ] as const) {
    expect(request?.url).toBe(`/api/workspaces/${ID}/identity/${resource}/${ID}`);
    expect(request?.init.method).toBe('DELETE');
    expect(bodyOf(request?.init)).toEqual({ revision: REVISION });
  }
  response = Response.json({ data: [], nextCursor: null });
  expect((await api.myCompanyIdentities(ID)).data).toEqual([]);
  expect(seen[5]?.url).toBe(`/api/workspaces/${ID}/company-identities`);
});

test('malformed catalogues cannot become selectable company providers', async () => {
  const { api } = setup(() =>
    Response.json({ data: [{ clientSecret: 'unexpected' }], nextCursor: null }),
  );
  const failures = await Promise.all(
    [api.companyDomains(ID), api.companyConnections(ID)].map(
      async (reading) =>
        await reading.then(
          () => undefined,
          (error: unknown) => error,
        ),
    ),
  );
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(ApiError);
    if (failure instanceof ApiError) expect(failure.code).toBe('MALFORMED');
  }
});
