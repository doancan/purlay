/** Native application handoff preserves authentication age and terminal workspace assurance. @needs-modules chat */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Selectable,
  type SessionAuthenticationEvidence,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { tokenDigest } from '../../platform/tokens';
import { aSession, TEST_AUTH_SECRET } from '../../testing/signed-in';
import { aUserRow, aUniqueSlug } from '../../testing/users';
import { signInCompanyNative } from '../../testing/company-native-auth';
import { recordPrimaryAuthentication } from './authentication-evidence';
import { authorizeNative, exchangeNativeCode } from './native-handoff';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const terms = { secret: TEST_AUTH_SECRET, sessionTtlDays: 30 };
const verifierPair = (): { readonly verifier: string; readonly challenge: string } => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const evidenceFor = async (
  sessionId: string,
): Promise<Selectable<SessionAuthenticationEvidence> | undefined> =>
  await clone.db
    .selectFrom('session_authentication_evidence')
    .selectAll()
    .where('session_id', '=', sessionId)
    .executeTakeFirst();
const workspaceFor = async (userId: string): Promise<string> => {
  const workspace = await clone.db
    .insertInto('workspaces')
    .values({ name: 'Native evidence', slug: aUniqueSlug('native-evidence') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await clone.db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: userId, role: 'owner' })
    .execute();
  return workspace.id;
};
const makeAssurance = async (
  userId: string,
  sessionId: string,
  workspaceId: string,
  revision: string,
  state: 'active' | 'expired' | 'ended',
  mfaState: 'active' | 'expired' = state === 'active' ? 'active' : 'expired',
): Promise<void> => {
  const at = systemClock.now().getTime();
  const lastUsedAt = new Date(at - 120_000);
  await clone.db
    .insertInto('workspace_session_assurances')
    .values({
      workspace_id: workspaceId,
      session_id: sessionId,
      user_id: userId,
      authentication_revision: revision,
      policy_revision: null,
      policy_epoch: 0,
      factor_scope: 'global',
      factor_id: crypto.randomUUID(),
      factor_revision: crypto.randomUUID(),
      mfa_verified_at: new Date(at - 180_000),
      mfa_expires_at: new Date(at + (mfaState === 'active' ? 60_000 : -30_000)),
      last_used_at: lastUsedAt,
      expires_at: new Date(at + (state === 'active' ? 120_000 : -60_000)),
      ended_at: state === 'ended' ? new Date(at - 30_000) : null,
      end_reason: state === 'ended' ? 'source_revoked' : null,
      created_at: new Date(at - 300_000),
      updated_at: new Date(at - 30_000),
    })
    .execute();
};

describe('integration: authentication-preserving native handoff', () => {
  test('source ownership is checked both when authorizing and when exchanging a retained legacy source', async () => {
    const owner = await aUserRow(clone.db, 'native-exact-source');
    const other = await aUserRow(clone.db, 'native-foreign-source');
    const source = await aSession(clone.db, systemClock, owner.userId);
    const pair = verifierPair();
    expect(
      await authorizeNative(clone.db, systemClock, {
        userId: other.userId,
        sourceSessionId: source.sessionId,
        challenge: pair.challenge,
      }).catch((error: unknown) => error),
    ).toMatchObject({ body: { code: 'UNAUTHENTICATED' } });
    expect(
      await clone.db
        .selectFrom('native_authorizations')
        .select('id')
        .where('user_id', '=', other.userId)
        .execute(),
    ).toEqual([]);
    // Retained UUIDs deliberately have no cascading source FK. A mismatched legacy row must still
    // fail the actual owner check instead of minting the foreign user's native session.
    const code = 'legacy-foreign-retained-source';
    await clone.db
      .insertInto('native_authorizations')
      .values({
        id: crypto.randomUUID(),
        created_at: systemClock.now(),
        spent_at: null,
        company_workspace_id: null,
        company_source_session_id: null,
        user_id: other.userId,
        code_digest: await tokenDigest(code),
        challenge: pair.challenge,
        authentication_source_session_id: source.sessionId,
        expires_at: new Date(systemClock.now().getTime() + 60_000),
      })
      .execute();
    const refused: string[] = [];
    expect(
      await exchangeNativeCode(clone.db, systemClock, terms, {
        code,
        verifier: pair.verifier,
        refused: (reason) => refused.push(reason),
      }),
    ).toBeUndefined();
    expect(refused).toEqual(['source-ended']);
    expect(
      await clone.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', other.userId)
        .execute(),
    ).toEqual([]);
  });

  test('active and expired MFA deadlines survive handoff while their separate base lifetime remains valid', async () => {
    const user = await aUserRow(clone.db, 'handoff-mfa-deadline');
    const source = await aSession(clone.db, systemClock, user.userId);
    await recordPrimaryAuthentication(clone.db, source.sessionId, user.userId, {
      method: 'password',
      authenticatedAt: systemClock.now(),
    });
    const primary = await evidenceFor(source.sessionId);
    if (primary === undefined) throw new Error('Missing primary authentication');
    for (const mfaState of ['active', 'expired'] as const)
      await makeAssurance(
        user.userId,
        source.sessionId,
        await workspaceFor(user.userId),
        primary.revision,
        'active',
        mfaState,
      );
    const before = await clone.db
      .selectFrom('workspace_session_assurances')
      .selectAll()
      .where('session_id', '=', source.sessionId)
      .orderBy('workspace_id')
      .execute();
    const now = systemClock.now();
    expect(before.every((row) => row.expires_at > now && row.ended_at === null)).toBe(true);
    expect(
      before.filter((row) => row.mfa_expires_at !== null && row.mfa_expires_at <= now),
    ).toHaveLength(1);
    expect(
      before.filter((row) => row.mfa_expires_at !== null && row.mfa_expires_at > now),
    ).toHaveLength(1);
    const pair = verifierPair();
    const { code } = await authorizeNative(clone.db, systemClock, {
      userId: user.userId,
      sourceSessionId: source.sessionId,
      challenge: pair.challenge,
    });
    const issued = await exchangeNativeCode(clone.db, systemClock, terms, {
      code,
      verifier: pair.verifier,
    });
    if (issued === undefined) throw new Error('Missing native handoff session');
    const after = await clone.db
      .selectFrom('workspace_session_assurances')
      .selectAll()
      .where('session_id', '=', issued.sessionId)
      .orderBy('workspace_id')
      .execute();
    expect(after).toEqual(before.map((row) => ({ ...row, session_id: issued.sessionId })));
  });

  test('exact source primary/MFA and every active, expired or ended workspace row retain their original age', async () => {
    const person = await aUserRow(clone.db, 'handoff-evidence');
    const source = await aSession(clone.db, systemClock, person.userId);
    const primaryAt = new Date(systemClock.now().getTime() - 86_400_000);
    await recordPrimaryAuthentication(clone.db, source.sessionId, person.userId, {
      method: 'password',
      authenticatedAt: primaryAt,
    });
    await clone.db
      .updateTable('session_authentication_evidence')
      .set({
        global_mfa_factor_id: crypto.randomUUID(),
        global_mfa_factor_revision: crypto.randomUUID(),
        global_mfa_method: 'totp',
        global_mfa_counter: 42,
        global_mfa_verified_at: new Date(primaryAt.getTime() + 30_000),
      })
      .where('session_id', '=', source.sessionId)
      .execute();
    const original = await evidenceFor(source.sessionId);
    if (original === undefined) throw new Error('Missing original authentication');
    for (const state of ['active', 'expired', 'ended'] as const)
      await makeAssurance(
        person.userId,
        source.sessionId,
        await workspaceFor(person.userId),
        original.revision,
        state,
      );
    const before = await clone.db
      .selectFrom('workspace_session_assurances')
      .selectAll()
      .where('session_id', '=', source.sessionId)
      .orderBy('workspace_id')
      .execute();
    const pair = verifierPair();
    const { code } = await authorizeNative(clone.db, systemClock, {
      userId: person.userId,
      challenge: pair.challenge,
      sourceSessionId: source.sessionId,
    });
    const grant = await clone.db
      .selectFrom('native_authorizations')
      .select('authentication_source_session_id')
      .where('code_digest', '=', await tokenDigest(code))
      .executeTakeFirstOrThrow();
    expect(grant.authentication_source_session_id).toBe(source.sessionId);
    const issued = await exchangeNativeCode(clone.db, systemClock, terms, {
      code,
      verifier: pair.verifier,
    });
    expect(issued).toBeDefined();
    const after = await evidenceFor(issued?.sessionId ?? '');
    if (issued === undefined || after === undefined)
      throw new Error('Missing native copied evidence');
    expect({ ...after, created_at: original.created_at, updated_at: original.updated_at }).toEqual({
      ...original,
      session_id: issued.sessionId,
    });
    const copied = await clone.db
      .selectFrom('workspace_session_assurances')
      .selectAll()
      .where('session_id', '=', issued.sessionId)
      .orderBy('workspace_id')
      .execute();
    expect(copied).toEqual(before.map((row) => ({ ...row, session_id: issued.sessionId })));
    expect(await evidenceFor(source.sessionId)).toEqual(original);
  });

  test('deleted exact source refuses exchange and its immutable retained UUID cannot fall back to legacy authority', async () => {
    const user = await aUserRow(clone.db, 'ended-handoff-source');
    const source = await aSession(clone.db, systemClock, user.userId);
    const pair = verifierPair();
    const { code } = await authorizeNative(clone.db, systemClock, {
      userId: user.userId,
      challenge: pair.challenge,
      sourceSessionId: source.sessionId,
    });
    await clone.db.deleteFrom('sessions').where('id', '=', source.sessionId).execute();
    expect(
      await exchangeNativeCode(clone.db, systemClock, terms, { code, verifier: pair.verifier }),
    ).toBeUndefined();
    const grant = await clone.db
      .selectFrom('native_authorizations')
      .select(['authentication_source_session_id', 'spent_at'])
      .where('code_digest', '=', await tokenDigest(code))
      .executeTakeFirstOrThrow();
    expect(grant.authentication_source_session_id).toBe(source.sessionId);
    expect(grant.spent_at).toBeNull();
    expect(
      await clone.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute(),
    ).toEqual([]);
  });

  test('a legacy grant and source with missing primary metadata never acquire fresh primary or workspace proof', async () => {
    const user = await aUserRow(clone.db, 'unknown-handoff');
    for (const source of [undefined, await aSession(clone.db, systemClock, user.userId)]) {
      const pair = verifierPair();
      const { code } = await authorizeNative(clone.db, systemClock, {
        userId: user.userId,
        challenge: pair.challenge,
        ...(source === undefined ? {} : { sourceSessionId: source.sessionId }),
      });
      const issued = await exchangeNativeCode(clone.db, systemClock, terms, {
        code,
        verifier: pair.verifier,
      });
      expect(issued).toBeDefined();
      expect(await evidenceFor(issued?.sessionId ?? '')).toBeUndefined();
      expect(
        await clone.db
          .selectFrom('workspace_session_assurances')
          .select('workspace_id')
          .where('session_id', '=', issued?.sessionId ?? '')
          .execute(),
      ).toEqual([]);
    }
  });

  test('company native handoff preserves issuer provenance but copies assurance only for that company', async () => {
    const world = await signInCompanyNative(clone.db);
    const { companySession } = world;
    const original = await evidenceFor(companySession.sessionId);
    if (original === undefined) throw new Error('Missing native company evidence');
    const workspaceId = companySession.companyWorkspaceId;
    if (workspaceId === undefined) throw new Error('Missing native company workspace');
    await makeAssurance(
      companySession.userId,
      companySession.sessionId,
      workspaceId,
      original.revision,
      'ended',
    );
    const other = await workspaceFor(companySession.userId);
    await makeAssurance(
      companySession.userId,
      companySession.sessionId,
      other,
      original.revision,
      'active',
    );
    const pair = verifierPair();
    const { code } = await authorizeNative(clone.db, systemClock, {
      userId: companySession.userId,
      sourceSessionId: companySession.sessionId,
      challenge: pair.challenge,
    });
    const issued = await exchangeNativeCode(clone.db, systemClock, terms, {
      code,
      verifier: pair.verifier,
    });
    expect(issued?.companyWorkspaceId).toBe(workspaceId);
    expect(await evidenceFor(issued?.sessionId ?? '')).toMatchObject({
      method: 'company_oidc',
      authenticated_at: original.authenticated_at,
      revision: original.revision,
      company_workspace_id: workspaceId,
      company_connection_id: original.company_connection_id,
      company_authentication_revision: original.company_authentication_revision,
    });
    const originalAssurance = await clone.db
      .selectFrom('workspace_session_assurances')
      .select(['workspace_id', 'ended_at', 'end_reason'])
      .where('session_id', '=', companySession.sessionId)
      .where('workspace_id', '=', workspaceId)
      .execute();
    expect(
      await clone.db
        .selectFrom('workspace_session_assurances')
        .select(['workspace_id', 'ended_at', 'end_reason'])
        .where('session_id', '=', issued?.sessionId ?? '')
        .execute(),
    ).toEqual(originalAssurance);
  });

  test('a reached assurance-copy SQL failure rolls back the new session, primary copy and spent grant', async () => {
    const user = await aUserRow(clone.db, 'atomic-handoff-evidence');
    const source = await aSession(clone.db, systemClock, user.userId);
    await recordPrimaryAuthentication(clone.db, source.sessionId, user.userId, {
      method: 'password',
      authenticatedAt: systemClock.now(),
    });
    const primary = await evidenceFor(source.sessionId);
    if (primary === undefined) throw new Error('Missing source');
    await makeAssurance(
      user.userId,
      source.sessionId,
      await workspaceFor(user.userId),
      primary.revision,
      'active',
    );
    const pair = verifierPair();
    const { code } = await authorizeNative(clone.db, systemClock, {
      userId: user.userId,
      sourceSessionId: source.sessionId,
      challenge: pair.challenge,
    });
    await sql`create sequence handoff_evidence_fault_hits`.execute(clone.db);
    await sql`create function handoff_evidence_fault() returns trigger language plpgsql as $$ begin perform nextval('handoff_evidence_fault_hits'); raise exception 'injected assurance copy failure'; end $$`.execute(
      clone.db,
    );
    await sql`create trigger handoff_evidence_fault before insert on workspace_session_assurances for each row execute function handoff_evidence_fault()`.execute(
      clone.db,
    );
    try {
      const outcome: unknown = await exchangeNativeCode(clone.db, systemClock, terms, {
        code,
        verifier: pair.verifier,
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome instanceof Error ? outcome.message : 'unexpected success').toBe(
        'injected assurance copy failure',
      );
      expect(
        (
          await sql<{
            called: boolean;
          }>`select is_called as called from handoff_evidence_fault_hits`.execute(clone.db)
        ).rows[0]?.called,
      ).toBe(true);
      expect(
        await clone.db
          .selectFrom('sessions')
          .select('id')
          .where('user_id', '=', user.userId)
          .execute(),
      ).toEqual([{ id: source.sessionId }]);
      expect(
        await clone.db
          .selectFrom('session_authentication_evidence')
          .select('session_id')
          .where('user_id', '=', user.userId)
          .execute(),
      ).toEqual([{ session_id: source.sessionId }]);
      expect(
        (
          await clone.db
            .selectFrom('native_authorizations')
            .select('spent_at')
            .where('code_digest', '=', await tokenDigest(code))
            .executeTakeFirstOrThrow()
        ).spent_at,
      ).toBeNull();
    } finally {
      await sql`drop trigger handoff_evidence_fault on workspace_session_assurances`.execute(
        clone.db,
      );
      await sql`drop function handoff_evidence_fault()`.execute(clone.db);
      await sql`drop sequence handoff_evidence_fault_hits`.execute(clone.db);
    }
    expect(
      await exchangeNativeCode(clone.db, systemClock, terms, { code, verifier: pair.verifier }),
    ).toBeDefined();
  });
});
