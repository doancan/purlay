/** Native enrollment cannot upgrade a user lock behind a status reader waiting on its factor. */
import { describe, afterAll, beforeAll, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';
import { requireWorkspaceSecurityMembership } from '../../platform/tenancy';
import { aTestAuth } from '../../testing/signed-in';
import { aUserRow, aUniqueSlug } from '../../testing/users';
import { cookiesFrom } from '../../testing/github-sign-in';
import { codeAt, keyOf } from '../../testing/totp';
import { workspaceAccessStatus } from '../workspaces/security/access';
import { NO_SESSION_LIFETIME } from './session-lifetime';
import { sessionFromHeaders } from './sessions';

describe('integration: native authentication row locks', () => {
  let clone: ClonedDatabase;
  beforeAll(async () => {
    clone = await cloneIntegrationDatabase();
  }, CLONE_HOOK_MS);
  afterAll(async () => {
    await clone.drop();
    await closeIntegrationDatabase();
  }, DROP_HOOK_MS);

  test('a real status user-share and native retained enrollment both finish after the observed SQL lock barrier', async () => {
    const user = await aUserRow(clone.db, 'native-lock-owner');
    const auth = aTestAuth(clone.db);
    const native = await auth.$context;
    const password = 'native lock enrollment long password 2026';
    await native.internalAdapter.linkAccount({
      userId: user.userId,
      accountId: user.userId,
      providerId: 'credential',
      password: await native.password.hash(password),
    });
    const baseHeaders = new Headers({
      origin: 'https://purlay.test',
      'content-type': 'application/json',
    });
    const signin = await auth.passwordSignIn(user.email, password, baseHeaders);
    expect(signin.status).toBe(200);
    const headers = new Headers(baseHeaders);
    headers.set('cookie', cookiesFrom(signin));
    const source = await sessionFromHeaders(auth, headers);
    if (source === undefined) throw new Error('Missing actual native session');
    const pending = await auth.handler(
      new Request('https://purlay.test/auth/two-factor/enable', {
        method: 'POST',
        headers,
        body: JSON.stringify({ password }),
      }),
    );
    expect(pending.status).toBe(200);
    const setup: unknown = await pending.json();
    if (
      typeof setup !== 'object' ||
      setup === null ||
      !('totpURI' in setup) ||
      typeof setup.totpURI !== 'string'
    )
      throw new Error('Missing actual native enrollment');
    const key = keyOf(setup.totpURI);
    const workspace = await clone.db
      .insertInto('workspaces')
      .values({ name: 'Native lock status', slug: aUniqueSlug('native-lock') })
      .returning('id')
      .executeTakeFirstOrThrow();
    await clone.db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: user.userId, role: 'owner' })
      .execute();
    const actor = {
      context: await requireWorkspaceSecurityMembership(clone.db, user.userId, workspace.id),
      sessionId: source.sessionId,
    };
    const reached = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const selected = new Set<
      Parameters<Parameters<Executor['withPlugin']>[0]['transformQuery']>[0]['queryId']
    >();
    const watched = clone.db.withPlugin({
      transformQuery: (
        args,
      ): ReturnType<Parameters<Executor['withPlugin']>[0]['transformQuery']> => {
        const node = JSON.stringify(args.node);
        if (node.includes('"name":"users"') && node.includes('"modifier":"ForShare"'))
          selected.add(args.queryId);
        return args.node;
      },
      transformResult: async (args) => {
        if (selected.delete(args.queryId)) {
          reached.resolve(undefined);
          await release.promise;
        }
        return args.result;
      },
    });
    const status = workspaceAccessStatus(
      {
        database: watched,
        clock: systemClock,
        cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
        lifetime: () => NO_SESSION_LIFETIME,
      },
      actor,
    );
    let verification: Promise<Response> | undefined;
    try {
      await reached.promise;
      const paused = await sql<{
        pid: number;
      }>`select pid from pg_stat_activity where datname=current_database() and state='idle in transaction' and query like '%from "users"%'`.execute(
        clone.db,
      );
      expect(paused.rows).toHaveLength(1);
      const blocker = paused.rows[0]?.pid;
      if (blocker === undefined) throw new Error('Missing actual status lock owner');
      verification = auth.handler(
        new Request('https://purlay.test/auth/two-factor/verify-totp', {
          method: 'POST',
          headers,
          body: JSON.stringify({ code: codeAt(key, Date.now()) }),
        }),
      );
      // Observe the PostgreSQL wait itself. The native request is attempted once; no scheduling sleep
      // or retry of authentication decides the interleaving.
      const deadline = Date.now() + 2_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const check = await sql<{
          waiting: boolean;
        }>`select exists(select 1 from pg_stat_activity where datname=current_database() and ${blocker}=any(pg_blocking_pids(pid))) as waiting`.execute(
          clone.db,
        );
        waiting = check.rows[0]?.waiting === true;
      }
      expect(waiting).toBe(true);
      release.resolve(undefined);
      const [shown, verified] = await Promise.all([status, verification]);
      expect(shown.state).toBe('allowed');
      expect(verified.status).toBe(200);
      expect((await sessionFromHeaders(auth, headers))?.sessionId).toBe(source.sessionId);
      expect(
        (
          await clone.db
            .selectFrom('two_factors')
            .select('verified')
            .where('user_id', '=', user.userId)
            .executeTakeFirstOrThrow()
        ).verified,
      ).toBe(true);
      expect(
        (
          await clone.db
            .selectFrom('session_authentication_evidence')
            .select('global_mfa_method')
            .where('session_id', '=', source.sessionId)
            .executeTakeFirstOrThrow()
        ).global_mfa_method,
      ).toBe('totp');
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([status, ...(verification === undefined ? [] : [verification])]);
    }
  });
});
