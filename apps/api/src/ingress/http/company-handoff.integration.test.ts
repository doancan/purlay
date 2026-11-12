/** Company authority must survive old user-wide mutation and native handoff surfaces. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  sql,
} from '@purlay/db';
import { messageId, NativeAuthorizeResponse } from '@purlay/types';
import { signInCompanyNative, companyNativeHeaders } from '../../testing/company-native-auth';
import { aRoom } from '../../testing/rooms';
import { testDependencies } from '../../testing/doubles';
import { systemClock } from '../../platform/clock';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import { tokenDigest } from '../../platform/tokens';
import {
  listCompanyConnections,
  setCompanyConnectionEnabled,
} from '../../modules/workspaces/identity/connections';
import { createApp } from './app';
import {
  authorizeNative,
  exchangeNativeCode,
  NATIVE_LIVE_CODES_PER_USER,
} from '../../modules/auth/native-handoff';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: company native handoff and upload authority', () => {
  test('a company exchange waiting on its workspace does not hold the grant needed by cap pruning', async () => {
    const world = await signInCompanyNative(clone.db);
    const verifier = 'q'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const grants: { code: string; digest: string }[] = [];
    for (let n = 0; n < NATIVE_LIVE_CODES_PER_USER; n++) {
      const grant = await authorizeNative(clone.db, systemClock, {
        userId: world.companySession.userId,
        sourceSessionId: world.companySession.sessionId,
        challenge,
      });
      grants.push({
        code: grant.code,
        digest: await tokenDigest(`company-native-code@purlay/v1:${grant.code}`),
      });
    }
    const oldest = await clone.db
      .selectFrom('native_authorizations')
      .select('code_digest')
      .where('user_id', '=', world.companySession.userId)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    const code = grants.find((entry) => entry.digest === oldest.code_digest)?.code;
    if (code === undefined) throw new Error('Missing oldest company grant');
    const holding = Promise.withResolvers<number>();
    const prune = Promise.withResolvers<undefined>();
    let exchanged: Promise<Awaited<ReturnType<typeof exchangeNativeCode>>> | undefined;
    const authorizing = clone.db.transaction().execute(async (tx) => {
      await sql`set local statement_timeout = '5s'`.execute(tx);
      await tx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', world.fixture.actor.context.workspaceId)
        .forUpdate()
        .execute();
      const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
      if (pid.rows[0] === undefined) throw new Error('Missing lock holder');
      holding.resolve(pid.rows[0].pid);
      await prune.promise;
      return await authorizeNative(tx, systemClock, {
        userId: world.companySession.userId,
        sourceSessionId: world.companySession.sessionId,
        challenge,
      });
    });
    try {
      const holder = await holding.promise;
      exchanged = exchangeNativeCode(
        clone.db,
        systemClock,
        { secret: 'native-race-fixture-secret', sessionTtlDays: 7 },
        { code, verifier },
      );
      // Observe the real lock, so the test cannot pass by scheduling the calls sequentially.
      let waiting = false;
      for (let n = 0; n < 200 && !waiting; n++) {
        const row = await sql<{ waiting: boolean }>`select exists(select 1 from pg_stat_activity
          where ${holder} = any(pg_blocking_pids(pid)) and query like '%workspaces%') as waiting`.execute(
          clone.db,
        );
        waiting = row.rows[0]?.waiting === true;
        if (!waiting) await Bun.sleep(5);
      }
      expect(waiting).toBe(true);
      prune.resolve(undefined);
      await authorizing;
      expect(await exchanged).toBeUndefined();
      expect(
        await clone.db
          .selectFrom('native_authorizations')
          .select('id')
          .where('user_id', '=', world.companySession.userId)
          .where('spent_at', 'is', null)
          .where('expires_at', '>', systemClock.now())
          .execute(),
      ).toHaveLength(NATIVE_LIVE_CODES_PER_USER);
    } finally {
      prune.resolve(undefined);
      await Promise.allSettled([authorizing, ...(exchanged === undefined ? [] : [exchanged])]);
    }
  }, 15_000);

  test('a real SQL failure copying company proof rolls back both the consumed grant and the minted session', async () => {
    const world = await signInCompanyNative(clone.db);
    const verifier = 't'.repeat(64);
    const grant = await authorizeNative(clone.db, systemClock, {
      userId: world.companySession.userId,
      sourceSessionId: world.companySession.sessionId,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    const before = await clone.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', world.companySession.userId)
      .orderBy('id')
      .execute();
    await sql`create function company_native_proof_fault() returns trigger language plpgsql as $$
      begin
        if current_setting('purlay.test_native_copy_fault', true) = 'on' then
          raise exception 'native proof fault';
        end if;
        return new;
      end $$`.execute(clone.db);
    await sql`create trigger company_native_proof_fault before insert on workspace_identity_sessions
      for each row execute function company_native_proof_fault()`.execute(clone.db);
    try {
      const failure = await clone.db
        .transaction()
        .execute(async (tx) => {
          await sql`set local purlay.test_native_copy_fault = 'on'`.execute(tx);
          return await exchangeNativeCode(
            tx,
            systemClock,
            { secret: 'native-fault-fixture-secret', sessionTtlDays: 7 },
            { code: grant.code, verifier },
          );
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) expect(failure.message).toContain('native proof fault');
      expect(
        await clone.db
          .selectFrom('sessions')
          .select('id')
          .where('user_id', '=', world.companySession.userId)
          .orderBy('id')
          .execute(),
      ).toEqual(before);
      expect(
        (
          await clone.db
            .selectFrom('native_authorizations')
            .select('spent_at')
            .where(
              'code_digest',
              '=',
              await tokenDigest(`company-native-code@purlay/v1:${grant.code}`),
            )
            .executeTakeFirstOrThrow()
        ).spent_at,
      ).toBeNull();
    } finally {
      await sql`drop trigger company_native_proof_fault on workspace_identity_sessions`.execute(
        clone.db,
      );
      await sql`drop function company_native_proof_fault()`.execute(clone.db);
    }
  });

  test('the actual native PKCE handoff keeps the issuing workspace instead of minting independent authority', async () => {
    const world = await signInCompanyNative(clone.db);
    const other = await aRoom(clone.db, ['handoff-other-owner']);
    await clone.db
      .insertInto('workspace_members')
      .values({
        workspace_id: other.workspaceId,
        user_id: world.companySession.userId,
        role: 'admin',
      })
      .execute();
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    const verifier = 'g'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorized = await app.handle(
      new Request('https://purlay.test/api/native/authorize', {
        method: 'POST',
        headers: companyNativeHeaders(world.cookie),
        body: JSON.stringify({ challenge, state: 's'.repeat(32) }),
      }),
    );
    expect(authorized.status).toBe(200);
    const body: unknown = await authorized.json();
    if (!Value.Check(NativeAuthorizeResponse, body))
      throw new Error('Invalid native authorization response');
    const code = new URL(body.redirect).searchParams.get('code');
    if (code === null) throw new Error('Missing opaque native code');
    // An older binary queries this digest and therefore cannot promote a company grant.
    expect(
      await clone.db
        .selectFrom('native_authorizations')
        .select('id')
        .where('code_digest', '=', await tokenDigest(code))
        .executeTakeFirst(),
    ).toBeUndefined();
    const exchange = await app.handle(
      new Request('https://purlay.test/api/native/token', {
        method: 'POST',
        headers: companyNativeHeaders(''),
        body: JSON.stringify({ code, verifier, device: { name: 'Company Mac' } }),
      }),
    );
    expect(exchange.status).toBe(204);
    const cookie = exchange.headers
      .getSetCookie()
      .filter((line) => !/Max-Age=0/i.test(line))
      .map((line) => line.split(';')[0] ?? '')
      .join('; ');
    const owner = await sessionFromHeaders(world.auth, companyNativeHeaders(cookie));
    expect(owner?.userId).toBe(world.companySession.userId);
    expect(owner?.companyWorkspaceId).toBe(world.companySession.companyWorkspaceId);
    // Existing native clients retain their cookie name; its separate MAC still rejects an older reader.
    expect(await world.auth.api.getSession({ headers: companyNativeHeaders(cookie) })).toBeNull();
    const globalMutation = await app.handle(
      new Request('https://purlay.test/auth/revoke-other-sessions', {
        method: 'POST',
        headers: companyNativeHeaders(cookie),
        body: '{}',
      }),
    );
    expect(globalMutation.status).toBe(403);
    expect(
      await sessionFromHeaders(world.auth, companyNativeHeaders(world.memberCookie)),
    ).toBeDefined();
    const foreign = await app.handle(
      new Request(`https://purlay.test/api/workspaces/${other.workspaceId}`, {
        headers: companyNativeHeaders(cookie),
      }),
    );
    expect(foreign.status).toBe(404);
  });

  test('company deletion cannot discard its canonical person’s unsent upload in another workspace', async () => {
    const world = await signInCompanyNative(clone.db);
    const other = await aRoom(clone.db, ['upload-other-owner']);
    await clone.db
      .insertInto('workspace_members')
      .values({
        workspace_id: other.workspaceId,
        user_id: world.companySession.userId,
        role: 'member',
      })
      .execute();
    const foreignId = messageId(systemClock.now());
    const ownId = messageId(systemClock.now());
    for (const [id, workspaceId] of [
      [foreignId, other.workspaceId],
      [ownId, world.companySession.companyWorkspaceId],
    ]) {
      if (id === undefined || workspaceId === undefined)
        throw new Error('Missing native attachment fixture');
      await clone.db
        .insertInto('attachments')
        .values({
          id,
          workspace_id: workspaceId,
          uploader_id: world.companySession.userId,
          file_name: 'unsent.pdf',
          mime_type: 'application/pdf',
          size_bytes: '4',
          storage_key: `w/${workspaceId}/${id}/upload`,
        })
        .execute();
    }
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    const discard = async (id: string, cookie: string): Promise<Response> => {
      const headers = companyNativeHeaders(cookie);
      headers.delete('content-type');
      return await app.handle(
        new Request(`https://purlay.test/api/attachments/${id}`, { method: 'DELETE', headers }),
      );
    };
    expect((await discard(foreignId, world.cookie)).status).toBe(404);
    expect(
      await clone.db
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', foreignId)
        .executeTakeFirst(),
    ).toBeDefined();
    const own = await discard(ownId, world.cookie);
    if (own.status !== 204)
      throw new Error(
        `Own upload refusal ${String(own.status)}: ${(await own.text()).slice(0, 500)}`,
      );
    expect((await discard(foreignId, world.memberCookie)).status).toBe(204);
  });

  for (const retired of ['browser-session', 'session-expired', 'provider'] as const)
    test(`native exchange refuses a ${retired} retired after authorization without creating a session`, async () => {
      const world = await signInCompanyNative(clone.db);
      const app = createApp(
        testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
      );
      const verifier = 'g'.repeat(64);
      const authorized = await app.handle(
        new Request('https://purlay.test/api/native/authorize', {
          method: 'POST',
          headers: companyNativeHeaders(world.cookie),
          body: JSON.stringify({
            challenge: createHash('sha256').update(verifier).digest('base64url'),
            state: 's'.repeat(32),
          }),
        }),
      );
      expect(authorized.status).toBe(200);
      const body: unknown = await authorized.json();
      if (!Value.Check(NativeAuthorizeResponse, body))
        throw new Error('Invalid native authorization response');
      const code = new URL(body.redirect).searchParams.get('code');
      if (code === null) throw new Error('Missing opaque native code');
      if (retired === 'browser-session')
        await clone.db
          .deleteFrom('sessions')
          .where('id', '=', world.companySession.sessionId)
          .execute();
      else if (retired === 'session-expired')
        await clone.db
          .updateTable('sessions')
          .set({ expires_at: new Date(systemClock.now().getTime() - 1_000) })
          .where('id', '=', world.companySession.sessionId)
          .execute();
      else {
        const current = (
          await listCompanyConnections(world.fixture.dependencies, world.fixture.actor)
        ).data.find((entry) => entry.id === world.connection.id);
        if (current === undefined) throw new Error('Missing company provider');
        await setCompanyConnectionEnabled(
          world.fixture.dependencies,
          world.fixture.actor,
          current.id,
          current.revision,
          false,
        );
      }
      const before = await clone.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', world.companySession.userId)
        .orderBy('id')
        .execute();
      const exchanged = await app.handle(
        new Request('https://purlay.test/api/native/token', {
          method: 'POST',
          headers: companyNativeHeaders(''),
          body: JSON.stringify({ code, verifier, device: { name: 'Company Mac' } }),
        }),
      );
      expect(exchanged.status).toBe(404);
      expect(exchanged.headers.getSetCookie()).toEqual([]);
      expect(
        await clone.db
          .selectFrom('sessions')
          .select('id')
          .where('user_id', '=', world.companySession.userId)
          .orderBy('id')
          .execute(),
      ).toEqual(before);
    });

  test('company native authorization cannot evict independent grants at the per-person cap', async () => {
    const world = await signInCompanyNative(clone.db);
    const verifier = 'g'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    for (let index = 0; index < NATIVE_LIVE_CODES_PER_USER; index++)
      await authorizeNative(clone.db, systemClock, {
        userId: world.companySession.userId,
        challenge,
        sourceSessionId: world.fixture.member.sessionId,
      });
    const before = await clone.db
      .selectFrom('native_authorizations')
      .select('id')
      .where('user_id', '=', world.companySession.userId)
      .orderBy('id')
      .execute();
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    const response = await app.handle(
      new Request('https://purlay.test/api/native/authorize', {
        method: 'POST',
        headers: companyNativeHeaders(world.cookie),
        body: JSON.stringify({ challenge, state: 's'.repeat(32) }),
      }),
    );
    expect(response.status).toBe(403);
    expect(
      await clone.db
        .selectFrom('native_authorizations')
        .select('id')
        .where('user_id', '=', world.companySession.userId)
        .orderBy('id')
        .execute(),
    ).toEqual(before);
  });
});
