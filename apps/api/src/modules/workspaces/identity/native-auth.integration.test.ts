/** Actual createAuth hooks, authenticated OAuth state, native SQL account/session finalization and cookies. Only the IdP is external. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { AUTH_BASE_PATH } from '@purlay/types';
import { systemClock } from '../../../platform/clock';
import { SESSION_COOKIE, COMPANY_SESSION_COOKIE } from '../../../platform/cookies';
import { sessionFromHeaders } from '../../auth/sessions';
import { aSession } from '../../../testing/signed-in';
import {
  setupCompanyNative,
  companyNativeHeaders as headers,
  beginCompanyNative as begin,
  dispatchCompanyNative as dispatch,
  roundtripCompanyNative as roundtrip,
  enableCompanyNative as enable,
} from '../../../testing/company-native-auth';
import { listCompanyConnections, setCompanyConnectionEnabled } from './connections';
import { companyProviderId } from './catalogue';
import { myCompanyIdentities, unlinkCompanyIdentity } from './bindings';
import { updateCompanyConnection } from './connections';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const setup = async (): Promise<Awaited<ReturnType<typeof setupCompanyNative>>> =>
  await setupCompanyNative(clone.db);

describe('integration: native company identity', () => {
  test('an IdP advertising a loopback browser destination receives a stable refusal without testing the connection', async () => {
    const configured = await setup();
    const { fixture, connection } = configured;
    configured.idp.behaviour.discovery = 'loopback-endpoints';
    const response = await configured.auth.handler(
      new Request(`https://purlay.test${AUTH_BASE_PATH}/company/start`, {
        method: 'POST',
        headers: headers(configured.ownerCookie),
        body: JSON.stringify({
          workspaceId: fixture.actor.context.workspaceId,
          connectionId: connection.id,
          revision: connection.revision,
          intent: 'test',
        }),
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'COMPANY_IDENTITY_UNAVAILABLE' });
    expect((await listCompanyConnections(fixture.dependencies, fixture.actor)).data[0]?.ready).toBe(
      false,
    );
  });

  test('repeating the same native link is idempotent and a different provider subject cannot replace it', async () => {
    const configured = await setup();
    const enabled = await enable(configured);
    const { fixture, connection } = configured;
    const input = {
      workspaceId: fixture.member.context.workspaceId,
      connectionId: connection.id,
      revision: enabled.revision,
      intent: 'link' as const,
    };
    configured.idp.person = { sub: 'original-subject', email: 'employee@company.example' };
    for (let n = 0; n < 2; n++)
      expect((await roundtrip(configured, input, configured.memberCookie)).status).toBe(302);
    const before = await clone.db
      .selectFrom('workspace_identity_bindings')
      .select(['id', 'subject'])
      .where('connection_id', '=', connection.id)
      .execute();
    expect(before).toHaveLength(1);
    expect(before[0]?.subject).toBe('original-subject');
    configured.idp.person = { sub: 'replacement-subject', email: 'employee@company.example' };
    expect((await roundtrip(configured, input, configured.memberCookie)).status).toBe(409);
    expect(
      await clone.db
        .selectFrom('workspace_identity_bindings')
        .select(['id', 'subject'])
        .where('connection_id', '=', connection.id)
        .execute(),
    ).toEqual(before);
  });

  test('a real test, explicit link and repeated sign-in preserve the canonical user with no provider tokens', async () => {
    const configured = await setup();
    const { fixture, connection, auth } = configured;
    const tested = await roundtrip(
      configured,
      {
        workspaceId: fixture.actor.context.workspaceId,
        connectionId: connection.id,
        revision: connection.revision,
        intent: 'test',
      },
      configured.ownerCookie,
    );
    expect(tested.status).toBe(302);
    expect(tested.headers.get('location')).toContain('/settings/company?identity=tested');
    expect(
      tested.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
    const current = (await listCompanyConnections(fixture.dependencies, fixture.actor)).data[0];
    if (current === undefined) throw new Error('Missing tested connection');
    expect(current.ready).toBe(true);
    expect(current.enabled).toBe(false);
    const enabled = await setCompanyConnectionEnabled(
      fixture.dependencies,
      fixture.actor,
      connection.id,
      current.revision,
      true,
    );
    const canonical = await clone.db
      .selectFrom('users')
      .select(['email', 'display_name'])
      .where('id', '=', fixture.member.context.userId)
      .executeTakeFirstOrThrow();
    configured.idp.person = {
      sub: 'immutable-employee',
      email: 'different-provider-address@example.test',
      name: 'Different name',
    };
    const linked = await roundtrip(
      configured,
      {
        workspaceId: fixture.member.context.workspaceId,
        connectionId: connection.id,
        revision: enabled.revision,
        intent: 'link',
      },
      configured.memberCookie,
    );
    expect(linked.status).toBe(302);
    expect(linked.headers.get('location')).toContain('/settings/account?identity=linked');
    expect(
      linked.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
    const accounts = await clone.db
      .selectFrom('accounts')
      .selectAll()
      .where('provider_id', '=', companyProviderId(connection.id))
      .execute();
    const binding = await clone.db
      .selectFrom('workspace_identity_bindings')
      .selectAll()
      .where('connection_id', '=', connection.id)
      .executeTakeFirstOrThrow();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.account_id).toBe(binding.id);
    expect(accounts[0]?.user_id).toBe(fixture.member.context.userId);
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    for (let index = 0; index < 2; index++) {
      const signedIn = await roundtrip(
        configured,
        { workspace: workspace.slug, connectionId: connection.id },
        '',
        true,
      );
      expect(signedIn.status).toBe(302);
      const cookie =
        signedIn.headers
          .getSetCookie()
          .find((value) => value.startsWith(`${COMPANY_SESSION_COOKIE}=`))
          ?.split(';')[0] ?? '';
      expect(cookie).not.toBe('');
      const session = await sessionFromHeaders(auth, headers(cookie));
      expect(session?.userId).toBe(fixture.member.context.userId);
      expect(session?.companyWorkspaceId).toBe(fixture.member.context.workspaceId);
      // Even if renamed, the company MAC is not a native credential an old reader can accept.
      expect(
        await auth.api.getSession({
          headers: headers(cookie.replace(COMPANY_SESSION_COOKIE, SESSION_COOKIE)),
        }),
      ).toBeNull();
    }
    const proofs = await clone.db
      .selectFrom('workspace_identity_sessions')
      .selectAll()
      .where('connection_id', '=', connection.id)
      .execute();
    expect(proofs).toHaveLength(2);
    for (const proof of proofs) {
      const row = await clone.db
        .selectFrom('sessions')
        .select('token_hash')
        .where('id', '=', proof.session_id)
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.binding_reference).toBe(binding.id);
    }
    expect(
      await clone.db
        .selectFrom('users')
        .select(['email', 'display_name'])
        .where('id', '=', fixture.member.context.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual(canonical);
    expect(
      accounts.every(
        (row) => row.access_token === null && row.refresh_token === null && row.id_token === null,
      ),
    ).toBe(true);
  });
  test('the native endpoint refuses client-selected authority and provider state fields', async () => {
    const configured = await setup();
    const { fixture, connection } = configured;
    const response = await configured.auth.handler(
      new Request(`https://purlay.test${AUTH_BASE_PATH}/company/start`, {
        method: 'POST',
        headers: headers(configured.ownerCookie),
        body: JSON.stringify({
          workspaceId: fixture.actor.context.workspaceId,
          connectionId: connection.id,
          revision: connection.revision,
          intent: 'test',
          userId: fixture.member.context.userId,
          additionalData: { companyIdentity: { intent: 'sign-in' } },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(configured.idp.calls.urls).toEqual([]);
  });

  test('a nonce mismatch cannot test credentials or enable sign-in', async () => {
    const configured = await setup();
    const { fixture, connection } = configured;
    configured.idp.behaviour.nonce = 'other';
    const response = await roundtrip(
      configured,
      {
        workspaceId: fixture.actor.context.workspaceId,
        connectionId: connection.id,
        revision: connection.revision,
        intent: 'test',
      },
      configured.ownerCookie,
    );
    expect(response.status).toBe(409);
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
    const current = (await listCompanyConnections(fixture.dependencies, fixture.actor)).data[0];
    expect(current?.ready).toBe(false);
    expect(current?.testedAt).toBeNull();
    expect(current?.revision).toBe(connection.revision);
  });

  test('an old callback cannot link after configuration changes', async () => {
    const configured = await setup();
    const enabled = await enable(configured);
    const { fixture, connection } = configured;
    const round = await begin(
      configured,
      {
        workspaceId: fixture.member.context.workspaceId,
        connectionId: connection.id,
        revision: enabled.revision,
        intent: 'link',
      },
      configured.memberCookie,
    );
    await updateCompanyConnection(fixture.dependencies, fixture.actor, connection.id, {
      revision: enabled.revision,
      name: 'Renamed office',
    });
    expect((await dispatch(configured, round)).status).toBe(409);
    expect(
      await clone.db
        .selectFrom('workspace_identity_bindings')
        .select('id')
        .where('connection_id', '=', connection.id)
        .execute(),
    ).toEqual([]);
    expect(
      await clone.db
        .selectFrom('accounts')
        .select('id')
        .where('provider_id', '=', companyProviderId(connection.id))
        .execute(),
    ).toEqual([]);
  });

  test('a revoked original session cannot be replaced with another valid browser session', async () => {
    const configured = await setup();
    const enabled = await enable(configured);
    const { fixture, connection } = configured;
    const round = await begin(
      configured,
      {
        workspaceId: fixture.member.context.workspaceId,
        connectionId: connection.id,
        revision: enabled.revision,
        intent: 'link',
      },
      configured.memberCookie,
    );
    await clone.db.deleteFrom('sessions').where('id', '=', fixture.member.sessionId).execute();
    expect((await dispatch(configured, round)).status).toBe(401);
    const state = round.cookies
      .split('; ')
      .filter((cookie) => !cookie.startsWith(`${SESSION_COOKIE}=`))
      .join('; ');
    const another = await begin(
      configured,
      {
        workspaceId: fixture.actor.context.workspaceId,
        connectionId: connection.id,
        revision: enabled.revision,
        intent: 'link',
      },
      configured.ownerCookie,
    );
    const switched = another.cookies
      .split('; ')
      .filter((cookie) => !cookie.startsWith(`${SESSION_COOKIE}=`))
      .join('; ');
    const replacement = await aSession(clone.db, systemClock, fixture.actor.context.userId);
    expect(
      (
        await dispatch(configured, {
          callback: another.callback,
          cookies: `${switched}; ${SESSION_COOKIE}=${replacement.token}`,
        })
      ).status,
    ).toBe(409);
    expect(state).not.toBe('');
  });

  test('unknown subjects never match by email; unlink retires the exact native account and prevents later login', async () => {
    const configured = await setup();
    const enabled = await enable(configured);
    const { fixture, connection } = configured;
    const canonical = await clone.db
      .selectFrom('users')
      .select('email')
      .where('id', '=', fixture.member.context.userId)
      .executeTakeFirstOrThrow();
    configured.idp.person = { sub: 'linked-subject', email: canonical.email };
    expect(
      (
        await roundtrip(
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
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', fixture.member.context.workspaceId)
      .executeTakeFirstOrThrow();
    configured.idp.person = { sub: 'different-subject', email: canonical.email };
    expect(
      (
        await roundtrip(
          configured,
          { workspace: workspace.slug, connectionId: connection.id },
          '',
          true,
        )
      ).status,
    ).toBe(409);
    configured.idp.person = { sub: 'linked-subject', email: canonical.email };
    expect(
      (
        await roundtrip(
          configured,
          { workspace: workspace.slug, connectionId: connection.id },
          '',
          true,
        )
      ).status,
    ).toBe(302);
    const mine = (await myCompanyIdentities(fixture.dependencies, fixture.member)).data[0];
    if (mine?.bindingId === null || mine === undefined) throw new Error('Missing owned identity');
    await unlinkCompanyIdentity(
      fixture.dependencies,
      fixture.member,
      connection.id,
      mine.bindingId,
    );
    expect(
      await clone.db
        .selectFrom('accounts')
        .select('id')
        .where('provider_id', '=', companyProviderId(connection.id))
        .execute(),
    ).toEqual([]);
    const proofs = await clone.db
      .selectFrom('workspace_identity_sessions')
      .select('revoked_at')
      .where('connection_id', '=', connection.id)
      .execute();
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.revoked_at).not.toBeNull();
    expect(
      (
        await roundtrip(
          configured,
          { workspace: workspace.slug, connectionId: connection.id },
          '',
          true,
        )
      ).status,
    ).toBe(409);
  });
  test('a reached proof-insert fault rolls back the native session before any cookie is issued', async () => {
    const configured = await setup();
    const enabled = await enable(configured);
    const { fixture, connection } = configured;
    configured.idp.person = { sub: 'rollback-subject', email: 'rollback@example.test' };
    expect(
      (
        await roundtrip(
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
    const workspace = await clone.db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', fixture.member.context.workspaceId)
      .executeTakeFirstOrThrow();
    const before = await clone.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', fixture.member.context.userId)
      .orderBy('id')
      .execute();
    await sql`create sequence identity_proof_fault_hits`.execute(clone.db);
    await sql`create function identity_proof_insert_fault() returns trigger language plpgsql as $$
      begin
        if new.connection_id = ${sql.lit(connection.id)}::uuid then
          perform nextval('identity_proof_fault_hits');
          raise exception 'reached native session proof insertion';
        end if;
        return new;
      end;
    $$`.execute(clone.db);
    await sql`create trigger identity_proof_insert_fault before insert on workspace_identity_sessions
      for each row execute function identity_proof_insert_fault()`.execute(clone.db);
    try {
      // createAuth deliberately throws unexpected SQL failures; ingress owns their HTTP envelope.
      const outcome: unknown = await roundtrip(
        configured,
        { workspace: workspace.slug, connectionId: connection.id },
        '',
        true,
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome instanceof Error ? outcome.message : 'unexpected response').toBe(
        'reached native session proof insertion',
      );
      expect(outcome instanceof Response).toBe(false);
      const hits = await sql<{
        is_called: boolean;
      }>`select is_called from identity_proof_fault_hits`.execute(clone.db);
      expect(hits.rows[0]?.is_called).toBe(true);
      expect(
        await clone.db
          .selectFrom('sessions')
          .select('id')
          .where('user_id', '=', fixture.member.context.userId)
          .orderBy('id')
          .execute(),
      ).toEqual(before);
      expect(
        await clone.db
          .selectFrom('workspace_identity_sessions')
          .select('session_id')
          .where('connection_id', '=', connection.id)
          .execute(),
      ).toEqual([]);
      expect(
        await clone.db
          .selectFrom('accounts')
          .select('id')
          .where('provider_id', '=', companyProviderId(connection.id))
          .execute(),
      ).toHaveLength(1);
    } finally {
      await sql`drop trigger identity_proof_insert_fault on workspace_identity_sessions`.execute(
        clone.db,
      );
      await sql`drop function identity_proof_insert_fault()`.execute(clone.db);
      await sql`drop sequence identity_proof_fault_hits`.execute(clone.db);
    }
  });
  for (const change of ['configuration', 'session', 'membership'] as const) {
    test(`committed ${change} change during provider exchange prevents account enrollment`, async () => {
      const configured = await setup();
      const enabled = await enable(configured);
      const { fixture, connection } = configured;
      let reached = false;
      configured.network.afterToken = async (): Promise<void> => {
        reached = true;
        if (change === 'configuration')
          await updateCompanyConnection(fixture.dependencies, fixture.actor, connection.id, {
            revision: enabled.revision,
            name: 'Changed during exchange',
          });
        if (change === 'session')
          await clone.db
            .deleteFrom('sessions')
            .where('id', '=', fixture.member.sessionId)
            .execute();
        if (change === 'membership')
          await clone.db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', fixture.member.context.workspaceId)
            .where('user_id', '=', fixture.member.context.userId)
            .execute();
      };
      const response = await roundtrip(
        configured,
        {
          workspaceId: fixture.member.context.workspaceId,
          connectionId: connection.id,
          revision: enabled.revision,
          intent: 'link',
        },
        configured.memberCookie,
      );
      expect(reached).toBe(true);
      expect(response.status).toBe(
        change === 'configuration' ? 409 : change === 'session' ? 401 : 404,
      );
      expect(
        await clone.db
          .selectFrom('workspace_identity_bindings')
          .select('id')
          .where('connection_id', '=', connection.id)
          .execute(),
      ).toEqual([]);
      expect(
        await clone.db
          .selectFrom('accounts')
          .select('id')
          .where('provider_id', '=', companyProviderId(connection.id))
          .execute(),
      ).toEqual([]);
      expect(
        response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
      ).toBe(false);
    });
  }
  test('a provider cannot send a company browser flow to a loopback authorization endpoint', async () => {
    const configured = await setup();
    const { fixture, connection } = configured;
    configured.idp.behaviour.discovery = 'loopback-endpoints';
    const response: unknown = await configured.auth
      .handler(
        new Request(`https://purlay.test${AUTH_BASE_PATH}/company/start`, {
          method: 'POST',
          headers: headers(configured.ownerCookie),
          body: JSON.stringify({
            workspaceId: fixture.actor.context.workspaceId,
            connectionId: connection.id,
            revision: connection.revision,
            intent: 'test',
          }),
        }),
      )
      .catch((error: unknown) => error);
    expect(response instanceof Response ? response.status : 'unexpected transport error').toBe(502);
    expect(configured.idp.presentedCodes).toEqual([]);
    expect(
      (await listCompanyConnections(fixture.dependencies, fixture.actor)).data[0]?.testedAt,
    ).toBeNull();
  });
});
