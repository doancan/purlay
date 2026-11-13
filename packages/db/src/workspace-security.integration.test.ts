/** Reached SQL constraints: native evidence and workspace proofs cannot change owners or revive authority. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql, type Transaction } from 'kysely';
import { MIGRATIONS_DIRECTORY } from './migrator';
import type { DB } from './schema';
import { executableText, splitStatements } from './statements';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
} from './testing';

let database: ClonedDatabase | undefined;
const legacyUser = crypto.randomUUID();
const legacySession = crypto.randomUUID();
const legacyWorkspace = crypto.randomUUID();
const legacyAssurances = [
  {
    sessionId: crypto.randomUUID(),
    lastUsedAt: new Date('2026-11-12T12:00:00Z'),
    expiresAt: new Date('2026-11-12T13:00:00Z'),
    mfa: true,
  },
  {
    sessionId: crypto.randomUUID(),
    lastUsedAt: new Date('2026-11-10T12:00:00Z'),
    expiresAt: new Date('2026-11-11T12:00:00Z'),
    mfa: true,
  },
  {
    sessionId: crypto.randomUUID(),
    lastUsedAt: new Date('2026-11-12T12:00:00Z'),
    expiresAt: new Date('2026-11-12T13:00:00Z'),
    mfa: false,
  },
] as const;

beforeAll(async () => {
  database = await cloneIntegrationDatabase();
  // Rebuild only this new schema in a private clone: source SQL mutations must reach actual constraints,
  // without changing migration records/checksums or taking DDL locks on another test's database (D-228).
  await sql`drop table session_authentication_evidence, workspace_access_policies,
    workspace_access_policy_tests, workspace_session_assurances, workspace_mfa_factors,
    workspace_mfa_challenges, workspace_mfa_recovery_codes cascade`.execute(database.db);
  await sql`drop function retain_native_factor_assurance(), retain_session_authentication_primary(),
    retain_native_authentication_source(), retain_workspace_access_policy_epoch(),
    retain_workspace_session_assurance(), retain_workspace_mfa_factor() cascade`.execute(
    database.db,
  );
  await sql`alter table two_factors drop column assurance_revision, drop column last_assurance_counter`.execute(
    database.db,
  );
  await sql`alter table native_authorizations drop column authentication_source_session_id cascade`.execute(
    database.db,
  );
  await sql`alter table workspaces drop column access_policy_epoch`.execute(database.db);
  await sql`drop index idx_sessions_native_owner`.execute(database.db);
  await database.db
    .insertInto('users')
    .values({
      id: legacyUser,
      email: `${legacyUser}@test.invalid`,
      username: legacyUser,
      display_name: 'Before policy',
    })
    .execute();
  await database.db
    .insertInto('sessions')
    .values({
      id: legacySession,
      user_id: legacyUser,
      token_hash: legacySession,
      expires_at: new Date('2026-11-13T00:00:00Z'),
    })
    .execute();
  await sql`insert into two_factors(user_id, secret, backup_codes, verified)
    values (${legacyUser}, 'old-sealed-key', 'old-sealed-codes', true)`.execute(database.db);
  await sql`insert into workspaces(id, name, slug)
    values (${legacyWorkspace}, 'Before policy', ${legacyWorkspace})`.execute(database.db);
  for (const name of [
    '0108_session_authentication_evidence.sql',
    '0109_workspace_access_policy.sql',
    '0110_workspace_mfa.sql',
    '0111_authentication_company_tuple.sql',
    '0112_workspace_mfa_deadline.sql',
  ]) {
    if (name === '0112_workspace_mfa_deadline.sql') {
      // Real rows written by the old schema: both live and expired MFA proofs, and a non-MFA control.
      await database.db
        .insertInto('workspace_members')
        .values({ workspace_id: legacyWorkspace, user_id: legacyUser })
        .execute();
      const factor = await database.db
        .insertInto('workspace_mfa_factors')
        .values({
          workspace_id: legacyWorkspace,
          user_id: legacyUser,
          secret_encrypted: Buffer.from('old-sealed-workspace-factor'),
          state: 'verified',
          verified_at: new Date('2026-11-10T12:00:00Z'),
        })
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow();
      for (const row of legacyAssurances) {
        await database.db
          .insertInto('sessions')
          .values({
            id: row.sessionId,
            user_id: legacyUser,
            token_hash: row.sessionId,
            expires_at: row.expiresAt,
          })
          .execute();
        const evidence = await database.db
          .insertInto('session_authentication_evidence')
          .values({
            session_id: row.sessionId,
            user_id: legacyUser,
            method: 'password',
            authenticated_at: row.lastUsedAt,
          })
          .returning('revision')
          .executeTakeFirstOrThrow();
        await database.db
          .insertInto('workspace_session_assurances')
          .values({
            workspace_id: legacyWorkspace,
            session_id: row.sessionId,
            user_id: legacyUser,
            authentication_revision: evidence.revision,
            policy_epoch: '0',
            last_used_at: row.lastUsedAt,
            expires_at: row.expiresAt,
            ...(row.mfa
              ? {
                  factor_scope: 'workspace',
                  factor_id: factor.id,
                  factor_revision: factor.revision,
                  mfa_verified_at: row.lastUsedAt,
                }
              : {}),
          })
          .execute();
      }
    }
    for (const statement of splitStatements(
      executableText(readFileSync(join(MIGRATIONS_DIRECTORY, name), 'utf8')),
    )) {
      await sql.raw(statement).execute(database.db);
    }
  }
}, CLONE_HOOK_MS);

afterAll(async () => {
  await database?.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const check = (body: (db: Transaction<DB>) => Promise<void>): Promise<void> => {
  if (database === undefined) throw new Error('Security SQL fixture was not initialized');
  return withRollback(body, database.db);
};

const NOW = new Date('2026-11-12T12:00:00Z');
const LATER = new Date('2026-11-12T13:00:00Z');
const hash = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

/** A rejected statement aborts its savepoint, not the fixture's surrounding transaction. */
const refused = async (
  db: Transaction<DB>,
  operation: () => Promise<unknown>,
  code = '23514',
): Promise<void> => {
  await sql`savepoint rejected_security_write`.execute(db);
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await sql`rollback to savepoint rejected_security_write`.execute(db);
  await sql`release savepoint rejected_security_write`.execute(db);
  expect(caught).toMatchObject({ code });
};

interface SecurityFixture {
  readonly user: string;
  readonly otherUser: string;
  readonly workspace: string;
  readonly otherWorkspace: string;
  readonly session: string;
  readonly otherSession: string;
  readonly authentication: string;
}

const fixture = async (db: Transaction<DB>): Promise<SecurityFixture> => {
  const user = crypto.randomUUID();
  const otherUser = crypto.randomUUID();
  const workspace = crypto.randomUUID();
  const otherWorkspace = crypto.randomUUID();
  const session = crypto.randomUUID();
  const otherSession = crypto.randomUUID();
  const authentication = crypto.randomUUID();
  await db
    .insertInto('users')
    .values(
      [user, otherUser].map((id) => ({
        id,
        email: `${id}@test.invalid`,
        username: id,
        display_name: 'Security',
      })),
    )
    .execute();
  await db
    .insertInto('workspaces')
    .values([workspace, otherWorkspace].map((id) => ({ id, name: 'Security', slug: id })))
    .execute();
  await db
    .insertInto('workspace_members')
    .values(
      [workspace, otherWorkspace].flatMap((workspace_id) =>
        [user, otherUser].map((user_id) => ({ workspace_id, user_id })),
      ),
    )
    .execute();
  await db
    .insertInto('sessions')
    .values(
      [session, otherSession].map((id) => ({
        id,
        user_id: user,
        token_hash: id,
        expires_at: LATER,
      })),
    )
    .execute();
  await db
    .insertInto('session_authentication_evidence')
    .values({
      session_id: session,
      user_id: user,
      revision: authentication,
      method: 'password',
      authenticated_at: NOW,
    })
    .execute();
  return { user, otherUser, workspace, otherWorkspace, session, otherSession, authentication };
};

describe('integration: workspace security SQL authority', () => {
  test('MFA deadline expansion preserves the old combined deadline, including expired proofs', async () => {
    await check(async (db) => {
      for (const legacy of legacyAssurances) {
        expect(
          await db
            .selectFrom('workspace_session_assurances')
            .select(['last_used_at', 'expires_at', 'mfa_verified_at', 'mfa_expires_at', 'ended_at'])
            .where('workspace_id', '=', legacyWorkspace)
            .where('session_id', '=', legacy.sessionId)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          last_used_at: legacy.lastUsedAt,
          expires_at: legacy.expiresAt,
          mfa_verified_at: legacy.mfa ? legacy.lastUsedAt : null,
          mfa_expires_at: legacy.mfa ? legacy.expiresAt : null,
          ended_at: null,
        });
      }
    });
  });

  test('expansion leaves existing sessions unknown, factors unconsumed and workspaces off', async () => {
    await check(async (db) => {
      expect(
        await db
          .selectFrom('session_authentication_evidence')
          .selectAll()
          .where('session_id', '=', legacySession)
          .execute(),
      ).toEqual([]);
      expect(
        (
          await db
            .selectFrom('workspaces')
            .select('access_policy_epoch')
            .where('id', '=', legacyWorkspace)
            .executeTakeFirstOrThrow()
        ).access_policy_epoch,
      ).toBe('0');
      expect(
        await db
          .selectFrom('workspace_access_policies')
          .selectAll()
          .where('workspace_id', '=', legacyWorkspace)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('two_factors')
          .select(['assurance_revision', 'last_assurance_counter'])
          .where('user_id', '=', legacyUser)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        assurance_revision: '00000000-0000-4000-8000-000000000000',
        last_assurance_counter: null,
      });
    });
  });

  test('unknown primary evidence cannot acquire company provenance', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      await refused(db, () =>
        db
          .insertInto('session_authentication_evidence')
          .values({
            session_id: f.otherSession,
            user_id: f.user,
            company_workspace_id: f.workspace,
            company_connection_id: crypto.randomUUID(),
            company_authentication_revision: crypto.randomUUID(),
          })
          .execute(),
      );
    });
  });

  test('native evidence binds the real session owner and keeps unknown primary evidence unknown', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      await refused(
        db,
        () =>
          db
            .insertInto('session_authentication_evidence')
            .values({ session_id: f.otherSession, user_id: f.otherUser })
            .execute(),
        '23503',
      );
      // Regression for SQL CHECK's three-valued NULL branch, at both insert and update.
      const mfa = {
        global_mfa_factor_id: crypto.randomUUID(),
        global_mfa_factor_revision: crypto.randomUUID(),
        global_mfa_counter: '10',
        global_mfa_verified_at: NOW,
      };
      await refused(db, () =>
        db
          .insertInto('session_authentication_evidence')
          .values({ session_id: f.otherSession, user_id: f.user, ...mfa })
          .execute(),
      );
      await db
        .insertInto('session_authentication_evidence')
        .values({ session_id: f.otherSession, user_id: f.user, ...mfa, global_mfa_method: 'totp' })
        .execute();
      const unknown = await db
        .selectFrom('session_authentication_evidence')
        .select(['method', 'authenticated_at'])
        .where('session_id', '=', f.otherSession)
        .executeTakeFirstOrThrow();
      expect(unknown).toEqual({ method: null, authenticated_at: null });
      await refused(db, () =>
        db
          .updateTable('session_authentication_evidence')
          .set({ global_mfa_method: null })
          .where('session_id', '=', f.otherSession)
          .execute(),
      );
      for (const change of [
        { method: null, authenticated_at: null },
        { revision: crypto.randomUUID() },
        { user_id: f.otherUser },
      ]) {
        await refused(db, () =>
          db
            .updateTable('session_authentication_evidence')
            .set(change)
            .where('session_id', '=', f.session)
            .execute(),
        );
      }
      await db.deleteFrom('sessions').where('id', '=', f.otherSession).execute();
      expect(
        await db
          .selectFrom('session_authentication_evidence')
          .select('session_id')
          .where('session_id', '=', f.otherSession)
          .execute(),
      ).toEqual([]);
    });
  });

  test('native factor material invalidates evidence and only a changed secret resets the counter', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      const factor = await db
        .insertInto('two_factors')
        .values({ user_id: f.user, secret: 'sealed-test', backup_codes: 'sealed-backup' })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .updateTable('two_factors')
        .set({ last_assurance_counter: '10' })
        .where('id', '=', factor.id)
        .execute();
      await refused(db, () =>
        db
          .updateTable('two_factors')
          .set({ last_assurance_counter: '9' })
          .where('id', '=', factor.id)
          .execute(),
      );
      await refused(db, () =>
        db
          .updateTable('two_factors')
          .set({ last_assurance_counter: null })
          .where('id', '=', factor.id)
          .execute(),
      );
      await refused(db, () =>
        db
          .updateTable('two_factors')
          .set({ user_id: f.otherUser })
          .where('id', '=', factor.id)
          .execute(),
      );
      const backup = await db
        .updateTable('two_factors')
        .set({ backup_codes: 'new-sealed-backup' })
        .where('id', '=', factor.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(backup.assurance_revision).not.toBe(factor.assurance_revision);
      expect(backup.last_assurance_counter).toBe('10');
      const verified = await db
        .updateTable('two_factors')
        .set({ verified: true })
        .where('id', '=', factor.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(verified.assurance_revision).not.toBe(backup.assurance_revision);
      expect(verified.last_assurance_counter).toBe('10');
      const rotated = await db
        .updateTable('two_factors')
        .set({ secret: 'rotated-sealed-test' })
        .where('id', '=', factor.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(rotated.assurance_revision).not.toBe(verified.assurance_revision);
      expect(rotated.last_assurance_counter).toBeNull();
    });
  });

  test('the retained epoch cannot decrease and provider arrays are one-dimensional nonnull UUID lists', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', f.workspace)
        .execute();
      await refused(db, () =>
        db
          .updateTable('workspaces')
          .set({ access_policy_epoch: '0' })
          .where('id', '=', f.workspace)
          .execute(),
      );
      await db
        .insertInto('workspace_access_policies')
        .values({ workspace_id: f.workspace, epoch: '1', mode: 'off', sign_in: 'any' })
        .execute();
      await refused(db, () =>
        sql`update workspace_access_policies set allowed_connection_ids = array[NULL]::uuid[] where workspace_id = ${f.workspace}::uuid`.execute(
          db,
        ),
      );
      await refused(db, () =>
        sql`update workspace_access_policies set allowed_connection_ids = array[[${f.workspace}::uuid]] where workspace_id = ${f.workspace}::uuid`.execute(
          db,
        ),
      );
      await refused(db, () =>
        sql`update workspace_access_policies set allowed_connection_ids = array_fill(${f.workspace}::uuid, array[1], array[0]) where workspace_id = ${f.workspace}::uuid`.execute(
          db,
        ),
      );
      await db
        .updateTable('workspace_access_policies')
        .set({ allowed_connection_ids: [crypto.randomUUID()] })
        .where('workspace_id', '=', f.workspace)
        .execute();
      expect(
        (
          await db
            .selectFrom('workspace_access_policies')
            .select('allowed_connection_ids')
            .where('workspace_id', '=', f.workspace)
            .executeTakeFirstOrThrow()
        ).allowed_connection_ids,
      ).toHaveLength(1);
      await db
        .deleteFrom('workspace_access_policies')
        .where('workspace_id', '=', f.workspace)
        .execute();
      expect(
        (
          await db
            .selectFrom('workspaces')
            .select('access_policy_epoch')
            .where('id', '=', f.workspace)
            .executeTakeFirstOrThrow()
        ).access_policy_epoch,
      ).toBe('1');
    });
  });

  test('assurances keep their native identity and an ended proof cannot be repurposed', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      const proof = {
        workspace_id: f.workspace,
        session_id: f.session,
        user_id: f.user,
        authentication_revision: f.authentication,
        policy_epoch: '0',
        last_used_at: NOW,
        expires_at: LATER,
      };
      await refused(
        db,
        () =>
          db
            .insertInto('workspace_session_assurances')
            .values({ ...proof, user_id: f.otherUser })
            .execute(),
        '23503',
      );
      await db.insertInto('workspace_session_assurances').values(proof).execute();
      for (const change of [
        { user_id: f.otherUser },
        { workspace_id: f.otherWorkspace },
        { authentication_revision: crypto.randomUUID() },
      ]) {
        await refused(db, () =>
          db
            .updateTable('workspace_session_assurances')
            .set(change)
            .where('session_id', '=', f.session)
            .execute(),
        );
      }
      await db
        .updateTable('workspace_session_assurances')
        .set({ ended_at: NOW, end_reason: 'expired' })
        .where('session_id', '=', f.session)
        .execute();
      await refused(db, () =>
        db
          .updateTable('workspace_session_assurances')
          .set({ ended_at: null, end_reason: null })
          .where('session_id', '=', f.session)
          .execute(),
      );
      await refused(db, () =>
        db
          .updateTable('workspace_session_assurances')
          .set({ end_reason: 'policy_changed' })
          .where('session_id', '=', f.session)
          .execute(),
      );
      expect(
        (
          await db
            .selectFrom('workspace_session_assurances')
            .select(['expires_at', 'ended_at'])
            .where('session_id', '=', f.session)
            .executeTakeFirstOrThrow()
        ).ended_at,
      ).toEqual(NOW);
    });
  });

  test('MFA assurance tuples require their own deadline and a non-MFA proof cannot invent one', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      const proof = {
        workspace_id: f.workspace,
        session_id: f.session,
        user_id: f.user,
        authentication_revision: f.authentication,
        policy_epoch: '0',
        last_used_at: NOW,
        expires_at: LATER,
      };
      const mfa = {
        factor_scope: 'workspace',
        factor_id: crypto.randomUUID(),
        factor_revision: crypto.randomUUID(),
        mfa_verified_at: NOW,
      };
      const mfaDeadline = new Date(NOW.getTime() + 5 * 60_000);
      await refused(db, () =>
        db
          .insertInto('workspace_session_assurances')
          .values({ ...proof, ...mfa })
          .execute(),
      );
      await refused(db, () =>
        db
          .insertInto('workspace_session_assurances')
          .values({ ...proof, mfa_expires_at: mfaDeadline })
          .execute(),
      );
      await db
        .insertInto('workspace_session_assurances')
        .values({ ...proof, ...mfa, mfa_expires_at: mfaDeadline })
        .execute();
      expect(
        await db
          .selectFrom('workspace_session_assurances')
          .select(['expires_at', 'mfa_expires_at'])
          .where('session_id', '=', f.session)
          .executeTakeFirstOrThrow(),
      ).toEqual({ expires_at: LATER, mfa_expires_at: mfaDeadline });
      await refused(db, () =>
        db
          .updateTable('workspace_session_assurances')
          .set({ mfa_expires_at: null })
          .where('session_id', '=', f.session)
          .execute(),
      );
      await refused(db, () =>
        db
          .updateTable('workspace_session_assurances')
          .set({
            factor_scope: null,
            factor_id: null,
            factor_revision: null,
            mfa_verified_at: null,
          })
          .where('session_id', '=', f.session)
          .execute(),
      );
    });
  });

  test('workspace factors rotate by a new row and retain monotonic counters and terminal revocation', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      const factor = await db
        .insertInto('workspace_mfa_factors')
        .values({
          workspace_id: f.workspace,
          user_id: f.user,
          secret_encrypted: Buffer.from('sealed'),
          state: 'pending',
          pending_expires_at: LATER,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await refused(db, () =>
        db
          .updateTable('workspace_mfa_factors')
          .set({ secret_encrypted: Buffer.from('replacement') })
          .where('id', '=', factor.id)
          .execute(),
      );
      await refused(db, () =>
        db
          .updateTable('workspace_mfa_factors')
          .set({ user_id: f.otherUser })
          .where('id', '=', factor.id)
          .execute(),
      );
      const verified = await db
        .updateTable('workspace_mfa_factors')
        .set({ state: 'verified', verified_at: NOW, last_accepted_counter: '10' })
        .where('id', '=', factor.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(verified.revision).not.toBe(factor.revision);
      await refused(db, () =>
        db
          .updateTable('workspace_mfa_factors')
          .set({ last_accepted_counter: '9' })
          .where('id', '=', factor.id)
          .execute(),
      );
      await refused(db, () =>
        db
          .updateTable('workspace_mfa_factors')
          .set({ last_accepted_counter: null })
          .where('id', '=', factor.id)
          .execute(),
      );
      await refused(db, () =>
        db
          .updateTable('workspace_mfa_factors')
          .set({ state: 'pending', verified_at: null })
          .where('id', '=', factor.id)
          .execute(),
      );
      const revoked = await db
        .updateTable('workspace_mfa_factors')
        .set({ state: 'revoked', revoked_at: NOW })
        .where('id', '=', factor.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(revoked.revision).not.toBe(verified.revision);
      await refused(db, () =>
        db
          .updateTable('workspace_mfa_factors')
          .set({ state: 'verified', revoked_at: null })
          .where('id', '=', factor.id)
          .execute(),
      );
      expect(revoked.last_accepted_counter).toBe('10');
    });
  });

  test('policy tests and challenges bind the same workspace, native user, session and authentication revision', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      const policyTest = {
        workspace_id: f.workspace,
        session_id: f.session,
        user_id: f.user,
        authentication_revision: f.authentication,
        policy_epoch: '0',
        token_hash: hash(),
        proposed_policy: {},
        proposed_digest: hash(),
        recovery_revision: crypto.randomUUID(),
        created_at: NOW,
        expires_at: LATER,
      };
      await refused(
        db,
        () =>
          db
            .insertInto('workspace_access_policy_tests')
            .values({ ...policyTest, user_id: f.otherUser })
            .execute(),
        '23503',
      );
      const saved = await db
        .insertInto('workspace_access_policy_tests')
        .values(policyTest)
        .returning('id')
        .executeTakeFirstOrThrow();
      const challenge = {
        workspace_id: f.workspace,
        session_id: f.session,
        user_id: f.user,
        authentication_revision: f.authentication,
        policy_epoch: '0',
        factor_scope: 'workspace',
        factor_id: crypto.randomUUID(),
        factor_revision: crypto.randomUUID(),
        purpose: 'policy_test',
        test_id: saved.id,
        token_hash: hash(),
        created_at: NOW,
        expires_at: LATER,
      };
      await refused(
        db,
        () =>
          db
            .insertInto('workspace_mfa_challenges')
            .values({ ...challenge, workspace_id: f.otherWorkspace })
            .execute(),
        '23503',
      );
      await refused(
        db,
        () =>
          db
            .insertInto('workspace_mfa_challenges')
            .values({ ...challenge, user_id: f.otherUser })
            .execute(),
        '23503',
      );
      await db
        .insertInto('session_authentication_evidence')
        .values({ session_id: f.otherSession, user_id: f.user, revision: f.authentication })
        .execute();
      await refused(
        db,
        () =>
          db
            .insertInto('workspace_mfa_challenges')
            .values({ ...challenge, session_id: f.otherSession })
            .execute(),
        '23503',
      );
      const savedChallenge = await db
        .insertInto('workspace_mfa_challenges')
        .values(challenge)
        .returning('id')
        .executeTakeFirstOrThrow();
      await refused(db, () =>
        db
          .updateTable('workspace_mfa_challenges')
          .set({ completed_at: NOW })
          .where('id', '=', savedChallenge.id)
          .execute(),
      );
      await db
        .updateTable('workspace_mfa_challenges')
        .set({ consumed_at: NOW, completed_at: NOW })
        .where('id', '=', savedChallenge.id)
        .execute();
      await db.deleteFrom('sessions').where('id', '=', f.session).execute();
      expect(
        await db
          .selectFrom('workspace_access_policy_tests')
          .select('id')
          .where('id', '=', saved.id)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_mfa_challenges')
          .select('id')
          .where('id', '=', savedChallenge.id)
          .execute(),
      ).toEqual([]);
    });
  });

  test('native handoff origins survive source deletion and company-bound source IDs agree', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      const grant = {
        id: crypto.randomUUID(),
        user_id: f.user,
        code_digest: hash().toString('hex'),
        challenge: hash().toString('base64url'),
        created_at: NOW,
        expires_at: LATER,
        company_workspace_id: f.workspace,
        company_source_session_id: f.session,
      };
      await refused(db, () =>
        db
          .insertInto('native_authorizations')
          .values({ ...grant, authentication_source_session_id: f.otherSession })
          .execute(),
      );
      await db
        .insertInto('native_authorizations')
        .values({ ...grant, authentication_source_session_id: f.session })
        .execute();
      await refused(db, () =>
        db
          .updateTable('native_authorizations')
          .set({ authentication_source_session_id: null })
          .where('id', '=', grant.id)
          .execute(),
      );
      await db.deleteFrom('sessions').where('id', '=', f.session).execute();
      expect(
        await db
          .selectFrom('native_authorizations')
          .select(['authentication_source_session_id', 'company_source_session_id'])
          .where('id', '=', grant.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        authentication_source_session_id: f.session,
        company_source_session_id: f.session,
      });
      // Legacy nullable provenance remains representable, never a fresh authentication claim.
      await db
        .insertInto('native_authorizations')
        .values({ ...grant, id: crypto.randomUUID(), code_digest: hash().toString('hex') })
        .execute();
    });
  });

  test('recovery codes can reference only the factor of their native member and cascade with it', async () => {
    await check(async (db) => {
      const f = await fixture(db);
      const factor = await db
        .insertInto('workspace_mfa_factors')
        .values({
          workspace_id: f.workspace,
          user_id: f.user,
          secret_encrypted: Buffer.from('sealed'),
          state: 'verified',
          verified_at: NOW,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const code = {
        workspace_id: f.workspace,
        user_id: f.user,
        purpose: 'factor',
        revision: crypto.randomUUID(),
        factor_id: factor.id,
        factor_revision: factor.revision,
        code_hash: hash(),
      };
      await refused(
        db,
        () =>
          db
            .insertInto('workspace_mfa_recovery_codes')
            .values({ ...code, user_id: f.otherUser })
            .execute(),
        '23503',
      );
      await db.insertInto('workspace_mfa_recovery_codes').values(code).execute();
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', f.workspace)
        .where('user_id', '=', f.user)
        .execute();
      expect(
        await db
          .selectFrom('workspace_mfa_factors')
          .select('id')
          .where('id', '=', factor.id)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .select('id')
          .where('factor_id', '=', factor.id)
          .execute(),
      ).toEqual([]);
    });
  });
});
