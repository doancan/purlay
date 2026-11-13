/** Stateful security crossings retain real native sign-in, policy receipts and consumed authenticator proof. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hashPassword } from 'better-auth/crypto';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  MyWorkspaceMfa,
  WorkspaceAccessPolicy,
  WorkspaceAccessStatus,
  WorkspaceMfaChallenge,
  WorkspaceMfaEnrollment,
  WorkspaceMfaRecoveryCodes,
  WorkspaceMfaVerified,
  WorkspacePolicyPreview,
  WorkspacePolicyRecovery,
  WorkspacePolicyTest,
  WorkspaceSecurityEntry,
  type WorkspacePolicySettings,
} from '@purlay/types/workspace-security';
import { WORKFLOW_CROSS_TENANT } from '../../testing/cross-tenant';
import { aMovableClock, testConfig, testDependencies } from '../../testing/doubles';
import { aTestAuth } from '../../testing/signed-in';
import { codeAt, keyOf } from '../../testing/totp';
import { aUniqueSlug, aUserRow, type TestUser } from '../../testing/users';
import { SESSION_COOKIE } from '../../platform/cookies';
import { withoutRequest } from '../../platform/logging';
import { createApp, type HttpApplication } from './app';

const PASSWORD = 'Native crossing fixture only 472!';
let passwordHash = '';
let owned: ClonedDatabase | undefined;
beforeAll(async () => {
  owned = await cloneIntegrationDatabase();
  passwordHash = await hashPassword(PASSWORD);
}, CLONE_HOOK_MS);
afterAll(async () => {
  await owned?.drop();
}, DROP_HOOK_MS);

const checked = async <S extends TSchema>(schema: S, response: Response): Promise<Static<S>> => {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!Value.Check(schema, body))
    throw new Error('The successful security response did not match its contract');
  return body;
};

interface World {
  readonly app: HttpApplication;
  readonly clock: ReturnType<typeof aMovableClock>;
  readonly workspaceId: string;
  readonly slug: string;
  readonly owner: string;
  readonly stranger: string;
  readonly prefix: string;
  readonly call: (
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
  ) => Promise<Response>;
  readonly own: (method: string, suffix: string, body?: unknown) => Promise<Response>;
}

const world = async (): Promise<World> => {
  if (owned === undefined) throw new Error('Missing workflow crossing database');
  const db = owned.db;
  const clock = aMovableClock(new Date());
  const owner = await aUserRow(db, 'security-cross-owner');
  const stranger = await aUserRow(db, 'security-cross-other');
  const slug = aUniqueSlug('security-cross');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Security crossing', slug })
    .returning('id')
    .executeTakeFirstOrThrow();
  const other = await db
    .insertInto('workspaces')
    .values({ name: 'Other security crossing', slug: aUniqueSlug('security-other') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspace.id, user_id: owner.userId, role: 'owner' },
      { workspace_id: other.id, user_id: stranger.userId, role: 'owner' },
    ])
    .execute();
  await db
    .insertInto('accounts')
    .values(
      [owner, stranger].map((person) => ({
        user_id: person.userId,
        account_id: person.userId,
        provider_id: 'credential',
        password: passwordHash,
      })),
    )
    .execute();
  const app = createApp(
    testDependencies({
      database: db,
      auth: aTestAuth(db, { clock }),
      clock,
      config: testConfig({ WORKSPACE_ACCESS_READY: true }),
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
  const signIn = async (person: TestUser): Promise<string> => {
    const response = await call('POST', '/auth/sign-in/email', '', {
      email: person.email,
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0];
    if (cookie === undefined) throw new Error('Native sign-in did not establish its real session');
    const evidence = await db
      .selectFrom('session_authentication_evidence')
      .select(['method', 'authenticated_at'])
      .where('user_id', '=', person.userId)
      .executeTakeFirst();
    expect(evidence?.method).toBe('password');
    expect(evidence?.authenticated_at).not.toBeNull();
    return cookie;
  };
  const ownerCookie = await signIn(owner);
  const strangerCookie = await signIn(stranger);
  const prefix = `/api/workspaces/${workspace.id}/security`;
  return {
    app,
    clock,
    workspaceId: workspace.id,
    slug,
    owner: ownerCookie,
    stranger: strangerCookie,
    prefix,
    call,
    own: async (method, suffix, body): Promise<Response> =>
      await call(method, `${prefix}${suffix}`, ownerCookie, body),
  };
};

const policy: WorkspacePolicySettings = {
  mode: 'enforced',
  signIn: 'any',
  allowedConnectionIds: [],
  requireMfa: false,
  idleMinutes: 15,
  maxAgeHours: 1,
  mfaMaxAgeMinutes: 5,
};
const recovery = async (f: World): Promise<WorkspacePolicyRecovery> =>
  await checked(
    WorkspacePolicyRecovery,
    await f.own('POST', '/recovery', { policyRevision: null }),
  );
const policyTest = async (f: World): Promise<WorkspacePolicyTest> =>
  await checked(
    WorkspacePolicyTest,
    await f.own('POST', '/policy/test', { revision: null, policy }),
  );
const enrollment = async (f: World): Promise<WorkspaceMfaEnrollment> =>
  await checked(
    WorkspaceMfaEnrollment,
    await f.own('POST', '/mfa/enrollment', { policyRevision: null, factorRevision: null }),
  );
const enrolled = async (
  f: World,
): Promise<{ readonly key: Buffer; readonly verified: WorkspaceMfaVerified }> => {
  const start = await enrollment(f);
  const key = keyOf(start.totpURI);
  const verified = await checked(
    WorkspaceMfaVerified,
    await f.own('POST', '/mfa/verify', {
      challengeId: start.challenge.challengeId,
      code: codeAt(key, f.clock.now().getTime()),
    }),
  );
  return { key, verified };
};
const challenge = async (
  f: World,
  purpose: 'step_up' | 'disable' | 'recovery_codes',
): Promise<WorkspaceMfaChallenge> =>
  await checked(
    WorkspaceMfaChallenge,
    await f.own('POST', '/mfa/challenges', {
      policyRevision: null,
      purpose,
      factorScope: 'workspace',
    }),
  );

/** Every registered route must have a real preparation; a new unhandled entry fails instead of borrowing another endpoint. */
const prepare = async (
  f: World,
  key: string,
): Promise<{ readonly body?: unknown; readonly schema: TSchema }> => {
  switch (key) {
    case 'GET /api/workspace-security':
      return { schema: WorkspaceSecurityEntry };
    case 'GET /api/workspaces/:workspaceId/security/access':
      return { schema: WorkspaceAccessStatus };
    case 'GET /api/workspaces/:workspaceId/security/policy':
      return { schema: WorkspaceAccessPolicy };
    case 'POST /api/workspaces/:workspaceId/security/policy/preview':
      return { body: { revision: null, policy }, schema: WorkspacePolicyPreview };
    case 'POST /api/workspaces/:workspaceId/security/policy/test':
      await recovery(f);
      return { body: { revision: null, policy }, schema: WorkspacePolicyTest };
    case 'PUT /api/workspaces/:workspaceId/security/policy': {
      await recovery(f);
      const proof = await policyTest(f);
      return {
        body: { revision: null, policy, testId: proof.testId, testToken: proof.testToken },
        schema: WorkspaceAccessPolicy,
      };
    }
    case 'POST /api/workspaces/:workspaceId/security/recovery':
      return { body: { policyRevision: null }, schema: WorkspacePolicyRecovery };
    case 'POST /api/workspaces/:workspaceId/security/recover': {
      const code = await recovery(f);
      const proof = await policyTest(f);
      await checked(
        WorkspaceAccessPolicy,
        await f.own('PUT', '/policy', {
          revision: null,
          policy,
          testId: proof.testId,
          testToken: proof.testToken,
        }),
      );
      return { body: code, schema: WorkspaceAccessPolicy };
    }
    case 'GET /api/workspaces/:workspaceId/security/mfa':
      return { schema: MyWorkspaceMfa };
    case 'POST /api/workspaces/:workspaceId/security/mfa/enrollment':
      return {
        body: { policyRevision: null, factorRevision: null },
        schema: WorkspaceMfaEnrollment,
      };
    case 'POST /api/workspaces/:workspaceId/security/mfa/challenges':
      await enrolled(f);
      return {
        body: { policyRevision: null, purpose: 'step_up', factorScope: 'workspace' },
        schema: WorkspaceMfaChallenge,
      };
    case 'POST /api/workspaces/:workspaceId/security/mfa/verify': {
      const start = await enrollment(f);
      return {
        body: {
          challengeId: start.challenge.challengeId,
          code: codeAt(keyOf(start.totpURI), f.clock.now().getTime()),
        },
        schema: WorkspaceMfaVerified,
      };
    }
    case 'POST /api/workspaces/:workspaceId/security/mfa/recovery': {
      const factor = await enrolled(f);
      const code = factor.verified.recoveryCodes?.backupCodes[0];
      if (code === undefined)
        throw new Error('Native enrollment did not return its real recovery batch');
      const proof = await challenge(f, 'step_up');
      return { body: { challengeId: proof.challengeId, code }, schema: WorkspaceMfaVerified };
    }
    case 'DELETE /api/workspaces/:workspaceId/security/mfa':
    case 'POST /api/workspaces/:workspaceId/security/mfa/recovery-codes': {
      const factor = await enrolled(f);
      f.clock.advance(30_000);
      const purpose = key.startsWith('DELETE ') ? 'disable' : 'recovery_codes';
      const receipt = await challenge(f, purpose);
      const verified = await checked(
        WorkspaceMfaVerified,
        await f.own('POST', '/mfa/verify', {
          challengeId: receipt.challengeId,
          code: codeAt(factor.key, f.clock.now().getTime()),
        }),
      );
      if (verified.factor === null) throw new Error('Missing verified factor receipt');
      return {
        body: {
          policyRevision: null,
          factorRevision: verified.factor.revision,
          authorizationChallengeId: receipt.challengeId,
        },
        schema: purpose === 'disable' ? MyWorkspaceMfa : WorkspaceMfaRecoveryCodes,
      };
    }
    default:
      throw new Error(`No real workflow preparation for ${key}`);
  }
};

describe('integration: dedicated native workspace-security crossings', () => {
  for (const [key] of Object.entries(WORKFLOW_CROSS_TENANT)) {
    test(`${key} preserves foreign/missing/malformed isolation and its real owner/self positive`, async () => {
      await withoutRequest(async () => {
        const f = await world();
        const prepared = await prepare(f, key);
        const [method = '', path = ''] = key.split(' ');
        const lookup = path === '/api/workspace-security';
        const aim = (identifier: string): string =>
          lookup
            ? `${path}?workspace=${encodeURIComponent(identifier)}`
            : path.replace(':workspaceId', identifier);
        const foreign = await f.call(
          method,
          aim(lookup ? f.slug : f.workspaceId),
          f.stranger,
          prepared.body,
        );
        expect(foreign.status).toBe(404);
        const refusal: unknown = await foreign.json();
        expect(refusal).toMatchObject({ error: { code: 'WORKSPACE_NOT_FOUND' } });
        const missing = await f.call(
          method,
          aim(lookup ? aUniqueSlug('no-security-workspace') : crypto.randomUUID()),
          f.stranger,
          prepared.body,
        );
        expect({ status: missing.status, body: await missing.json() }).toEqual({
          status: 404,
          body: refusal,
        });
        const malformed = await f.call(
          method,
          aim(lookup ? '!invalid slug!' : 'not-a-uuid'),
          f.stranger,
          prepared.body,
        );
        if (lookup) {
          // Slug syntax is an explicit query contract; a valid foreign/missing slug above remains the strict tenant404.
          expect(malformed.status).toBe(400);
          expect(await malformed.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
        } else
          expect({ status: malformed.status, body: await malformed.json() }).toEqual({
            status: 404,
            body: refusal,
          });
        const own = await f.call(
          method,
          aim(lookup ? f.slug : f.workspaceId),
          f.owner,
          prepared.body,
        );
        expect(own.status).toBe(200);
        expect(own.headers.get('cache-control')).toBe('no-store');
        const body: unknown = await own.json();
        expect(Value.Check(prepared.schema, body)).toBe(true);
        await f.app.settled();
      });
    });
  }
});
