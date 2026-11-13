/** Actual SQL policy/proof clocks; native verification itself is covered at its owning boundary. */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Selectable,
  type WorkspaceSessionAssurances,
} from '@purlay/db';
import type { WorkspacePolicySettings } from '@purlay/types/workspace-security';
import { requireWorkspaceSecurityMembership } from '../../../platform/tenancy';
import {
  readWorkspaceAccessDecision,
  readWorkspaceAccessDecisions,
  type WorkspaceAccessRead,
} from '../../../platform/workspace-access';
import { aSession } from '../../../testing/signed-in';
import { aUniqueSlug } from '../../../testing/users';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import { recordWorkspaceMfaVerification, workspaceAccessStatus } from './access';
import type { WorkspaceSecurityActor, WorkspaceSecurityDependencies } from './authority';
import {
  companyWorkspaceMfaActor,
  securityOutcome,
  workspaceMfaFixture,
  type WorkspaceMfaFixture,
} from './mfa.testing';

afterAll(closeIntegrationDatabase);
const readInput = (f: WorkspaceMfaFixture): WorkspaceAccessRead => ({
  sessionId: f.actor.sessionId,
  userId: f.actor.context.userId,
  workspaceIds: [f.actor.context.workspaceId],
  now: f.dependencies.clock.now(),
  lifetime: f.dependencies.lifetime(),
});
const status = async (
  f: WorkspaceMfaFixture,
): Promise<Awaited<ReturnType<typeof workspaceAccessStatus>>> =>
  await workspaceAccessStatus(f.dependencies, f.actor);
const decision = async (
  f: WorkspaceMfaFixture,
): Promise<Awaited<ReturnType<typeof readWorkspaceAccessDecision>>> =>
  await readWorkspaceAccessDecision(f.dependencies.database, {
    ...readInput(f),
    workspaceId: f.actor.context.workspaceId,
  });
const policy = async (
  f: WorkspaceMfaFixture,
  overrides: Partial<WorkspacePolicySettings> = {},
): Promise<string> => {
  const db = f.dependencies.database;
  const id = f.actor.context.workspaceId;
  const workspace = await db
    .selectFrom('workspaces')
    .select('access_policy_epoch')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const epoch = String(BigInt(workspace.access_policy_epoch) + 1n);
  const revision = crypto.randomUUID();
  await db
    .updateTable('workspaces')
    .set({ access_policy_epoch: epoch })
    .where('id', '=', id)
    .execute();
  const settings: WorkspacePolicySettings = {
    mode: 'enforced',
    signIn: 'any',
    allowedConnectionIds: [],
    requireMfa: false,
    idleMinutes: 15,
    maxAgeHours: 1,
    mfaMaxAgeMinutes: 5,
    ...overrides,
  };
  const values = {
    epoch,
    revision,
    mode: settings.mode,
    sign_in: settings.signIn,
    allowed_connection_ids: settings.allowedConnectionIds,
    require_mfa: settings.requireMfa,
    idle_minutes: settings.idleMinutes,
    max_age_hours: settings.maxAgeHours,
    mfa_max_age_minutes: settings.mfaMaxAgeMinutes,
  };
  await db
    .insertInto('workspace_access_policies')
    .values({ workspace_id: id, ...values })
    .onConflict((conflict) => conflict.column('workspace_id').doUpdateSet(values))
    .execute();
  return revision;
};
const assurance = async (
  f: WorkspaceMfaFixture,
): Promise<Selectable<WorkspaceSessionAssurances> | undefined> =>
  await f.dependencies.database
    .selectFrom('workspace_session_assurances')
    .selectAll()
    .where('workspace_id', '=', f.actor.context.workspaceId)
    .where('session_id', '=', f.actor.sessionId)
    .executeTakeFirst();
const globalFactor = async (
  f: WorkspaceMfaFixture,
): Promise<{ readonly id: string; readonly revision: string }> => {
  const made = await f.dependencies.database
    .insertInto('two_factors')
    .values({
      id: crypto.randomUUID(),
      user_id: f.actor.context.userId,
      secret: 'opaque native fixture secret',
      backup_codes: 'opaque native backup fixture',
      verified: true,
      last_assurance_counter: 42,
    })
    .returning(['id', 'assurance_revision'])
    .executeTakeFirstOrThrow();
  // The native INSERT trigger initializes its accepted-counter ledger, so record a genuine captured fact explicitly.
  await f.dependencies.database
    .updateTable('two_factors')
    .set({ last_assurance_counter: 42 })
    .where('id', '=', made.id)
    .execute();
  return { id: made.id, revision: made.assurance_revision };
};
const capturedGlobal = async (
  f: WorkspaceMfaFixture,
  factor: { readonly id: string; readonly revision: string },
  counter = 42,
): Promise<void> => {
  await f.dependencies.database
    .updateTable('two_factors')
    .set({ last_assurance_counter: counter })
    .where('id', '=', factor.id)
    .execute();
  await f.dependencies.database
    .updateTable('session_authentication_evidence')
    .set({
      global_mfa_factor_id: factor.id,
      global_mfa_factor_revision: factor.revision,
      global_mfa_method: 'totp',
      global_mfa_counter: counter,
      global_mfa_verified_at: f.dependencies.clock.now(),
    })
    .where('session_id', '=', f.actor.sessionId)
    .execute();
};
const workspaceFactor = async (
  f: WorkspaceMfaFixture,
): Promise<{ readonly id: string; readonly revision: string }> =>
  await f.dependencies.database
    .insertInto('workspace_mfa_factors')
    .values({
      workspace_id: f.actor.context.workspaceId,
      user_id: f.actor.context.userId,
      secret_encrypted: Buffer.from('sealed workspace fixture'),
      state: 'verified',
      verified_at: f.dependencies.clock.now(),
      created_at: f.dependencies.clock.now(),
      updated_at: f.dependencies.clock.now(),
    })
    .returning(['id', 'revision'])
    .executeTakeFirstOrThrow();
const receipt = async (
  f: WorkspaceMfaFixture,
  factor: { readonly id: string; readonly revision: string },
): Promise<void> => {
  const db = f.dependencies.database;
  const source = await db
    .selectFrom('session_authentication_evidence')
    .select('revision')
    .where('session_id', '=', f.actor.sessionId)
    .executeTakeFirstOrThrow();
  const p = await db
    .selectFrom('workspace_access_policies')
    .select(['revision', 'epoch'])
    .where('workspace_id', '=', f.actor.context.workspaceId)
    .executeTakeFirst();
  const now = f.dependencies.clock.now();
  await db
    .insertInto('workspace_mfa_challenges')
    .values({
      workspace_id: f.actor.context.workspaceId,
      user_id: f.actor.context.userId,
      session_id: f.actor.sessionId,
      authentication_revision: source.revision,
      policy_revision: p?.revision ?? null,
      policy_epoch: p?.epoch ?? '0',
      factor_scope: 'workspace',
      factor_id: factor.id,
      factor_revision: factor.revision,
      purpose: 'step_up',
      token_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      created_at: now,
      expires_at: new Date(now.getTime() + 60_000),
      consumed_at: now,
      completed_at: now,
    })
    .execute();
};

describe('integration: workspace access evidence and deadlines', () => {
  test('removed membership cannot borrow another member even before any workspace policy is enabled', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      expect((await decision(f)).allowed).toBe(true);
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      expect((await decision(f)).reason).toBe('membership_invalid');
    });
  });
  test('epoch0 unknown legacy stays allowed without manufacturing primary or assurance; enforcing requires real primary', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await db
        .deleteFrom('session_authentication_evidence')
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      expect((await decision(f)).allowed).toBe(true);
      expect((await status(f)).state).toBe('allowed');
      expect(await assurance(f)).toBeUndefined();
      await policy(f);
      await db
        .updateTable('users')
        .set({ two_factor_enabled: true })
        .where('id', '=', f.actor.context.userId)
        .execute();
      expect((await decision(f)).reason).toBe('primary_unknown');
      expect((await status(f)).state).toBe('sign_in_required');
      expect(await assurance(f)).toBeUndefined();
    });
  });
  test('readonly missing assurance never bootstraps; explicit self status materializes immutable source without idle touches', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f);
      expect((await decision(f)).reason).toBe('assurance_missing');
      expect(await assurance(f)).toBeUndefined();
      expect((await status(f)).state).toBe('allowed');
      const before = await assurance(f);
      f.move(60_000);
      expect((await decision(f)).allowed).toBe(true);
      expect(await assurance(f)).toEqual(before);
      expect((await status(f)).state).toBe('allowed');
      expect(await assurance(f)).toMatchObject({
        last_used_at: before?.last_used_at,
        expires_at: before?.expires_at,
      });
      expect(
        (await readWorkspaceAccessDecisions(db, { ...readInput(f), workspaceIds: [] })).size,
      ).toBe(0);
    });
  });
  test('retained positive epoch with missing or mismatched policy fails closed', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', f.actor.context.workspaceId)
        .execute();
      expect((await decision(f)).reason).toBe('policy_invalid');
      expect((await status(f)).state).toBe('sign_in_required');
      await policy(f);
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '3' })
        .where('id', '=', f.actor.context.workspaceId)
        .execute();
      expect((await decision(f)).reason).toBe('policy_invalid');
      expect(await assurance(f)).toBeUndefined();
    });
  });
  test('wrong/missing native source, revoked session and pending user never authorize read-only work', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f);
      await status(f);
      for (const sessionId of [crypto.randomUUID(), f.member.sessionId]) {
        const denied = await readWorkspaceAccessDecision(db, {
          ...readInput(f),
          sessionId,
          workspaceId: f.actor.context.workspaceId,
        });
        expect(denied.allowed).toBe(false);
      }
      await db
        .updateTable('sessions')
        .set({ revoked_at: f.dependencies.clock.now() })
        .where('id', '=', f.actor.sessionId)
        .execute();
      expect((await decision(f)).reason).toBe('native_invalid');
      await db
        .updateTable('sessions')
        .set({ revoked_at: null })
        .where('id', '=', f.actor.sessionId)
        .execute();
      await db
        .updateTable('users')
        .set({ admission_state: 'pending' })
        .where('id', '=', f.actor.context.userId)
        .execute();
      expect((await decision(f)).allowed).toBe(false);
    });
  });
  test('company-only sign-in exempts restricted guests from provider choice but keeps their expiry restriction', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { signIn: 'company' });
      expect((await status(f)).state).toBe('sign_in_required');
      await db
        .updateTable('workspace_members')
        .set({
          role: 'member',
          access_kind: 'guest',
          guest_since: new Date(f.dependencies.clock.now().getTime() - 60_000),
          guest_modules: ['chat'],
          guest_expires_at: null,
        })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      expect((await status(f)).state).toBe('allowed');
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: f.dependencies.clock.now() })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      expect((await decision(f)).reason).toBe('membership_invalid');
    });
  });
  test('primary age follows copied authentication time rather than new native session creation', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { idleMinutes: null, maxAgeHours: 1 });
      const fresh = await aSession(db, f.dependencies.clock, f.actor.context.userId);
      await recordPrimaryAuthentication(db, fresh.sessionId, f.actor.context.userId, {
        method: 'password',
        authenticatedAt: new Date(f.dependencies.clock.now().getTime() - 60 * 60_000),
      });
      const copied = { ...f, actor: { ...f.actor, sessionId: fresh.sessionId } };
      expect((await decision(copied)).status.state).toBe('expired');
      expect((await status(copied)).state).toBe('expired');
    });
  });
  test('registered global factor is not session MFA; captured native events retain age through expiry, relaxation and newer proof', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { requireMfa: true });
      const factor = await globalFactor(f);
      expect((await status(f)).state).toBe('mfa_required');
      expect((await assurance(f))?.factor_scope).toBeNull();
      await capturedGlobal(f, factor);
      expect((await status(f)).state).toBe('allowed');
      await workspaceFactor(f);
      expect((await status(f)).factorScope).toBe('global');
      const original = await assurance(f);
      f.move(5 * 60_000);
      expect((await decision(f)).reason).toBe('mfa_expired');
      await policy(f, { requireMfa: true, mfaMaxAgeMinutes: 30 });
      expect((await status(f)).state).toBe('mfa_required');
      expect((await assurance(f))?.mfa_expires_at).toEqual(original?.mfa_expires_at);
      await capturedGlobal(f, factor, 43);
      expect((await status(f)).state).toBe('allowed');
      expect((await assurance(f))?.last_used_at).toEqual(original?.last_used_at);
      expect((await assurance(f))?.expires_at).toEqual(original?.expires_at);
      await db
        .updateTable('two_factors')
        .set({ backup_codes: 'changed sealed material' })
        .where('id', '=', factor.id)
        .execute();
      expect((await decision(f)).reason).toBe('mfa_missing');
      expect((await status(f)).state).toBe('mfa_required');
    });
  });
  test('mere registered workspace factor or foreign receipt cannot mint assurance; exact accepted scoped receipt can', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const factor = await workspaceFactor(f);
      const proof = {
        factorId: factor.id,
        factorRevision: factor.revision,
        verifiedAt: f.dependencies.clock.now(),
      };
      expect(
        await securityOutcome(async () => {
          await recordWorkspaceMfaVerification(db, f.dependencies, f.actor, proof);
        }),
      ).toBe('WORKSPACE_SECURITY_NOT_READY');
      expect(await assurance(f)).toBeUndefined();
      await receipt(f, factor);
      f.move(7); // Real crypto/SQL completion need not share the accepted event's millisecond.
      await recordWorkspaceMfaVerification(db, f.dependencies, f.actor, proof);
      const first = await assurance(f);
      expect(first?.factor_scope).toBe('workspace');
      expect(first?.mfa_verified_at).toEqual(proof.verifiedAt);
      expect((await status(f)).mfaVerifiedAt).toBe(proof.verifiedAt.toISOString());
      f.move(1);
      await recordWorkspaceMfaVerification(db, f.dependencies, f.actor, proof);
      expect(await assurance(f)).toEqual(first);
    });
  });
  test('enforced workspace proof requires the exact current factor revision and expires separately from its base', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { requireMfa: true });
      const factor = await workspaceFactor(f);
      await receipt(f, factor);
      await recordWorkspaceMfaVerification(db, f.dependencies, f.actor, {
        factorId: factor.id,
        factorRevision: factor.revision,
        verifiedAt: f.dependencies.clock.now(),
      });
      expect((await decision(f)).allowed).toBe(true);
      f.move(5 * 60_000);
      expect((await decision(f)).reason).toBe('mfa_expired');
      const before = await assurance(f);
      await db
        .updateTable('workspace_mfa_factors')
        .set({ state: 'revoked', revoked_at: f.dependencies.clock.now() })
        .where('id', '=', factor.id)
        .execute();
      expect((await decision(f)).status.state).toBe('mfa_enrollment_required');
      expect(await assurance(f)).toEqual(before);
    });
  });
  test('native MFA evidence ahead of its accepted counter or clock cannot manufacture a verified session', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { requireMfa: true });
      const factor = await globalFactor(f);
      await capturedGlobal(f, factor);
      await db
        .updateTable('session_authentication_evidence')
        .set({ global_mfa_counter: 43 })
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      expect((await status(f)).state).toBe('mfa_required');
      await db
        .updateTable('session_authentication_evidence')
        .set({
          global_mfa_counter: 42,
          global_mfa_verified_at: new Date(f.dependencies.clock.now().getTime() + 1),
        })
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      expect((await status(f)).state).toBe('mfa_required');
      expect((await assurance(f))?.mfa_verified_at).toBeNull();
    });
  });
  test('base deadline becomes terminal and cannot revive through policy off, relaxed age or a new MFA receipt', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { idleMinutes: 5 });
      await status(f);
      const original = await assurance(f);
      f.move(5 * 60_000);
      expect((await status(f)).state).toBe('expired');
      expect((await assurance(f))?.ended_at).toEqual(f.dependencies.clock.now());
      await policy(f, { mode: 'off', idleMinutes: null, maxAgeHours: null });
      expect((await status(f)).state).toBe('expired');
      const factor = await workspaceFactor(f);
      await receipt(f, factor);
      expect(
        await securityOutcome(async () => {
          await recordWorkspaceMfaVerification(db, f.dependencies, f.actor, {
            factorId: factor.id,
            factorRevision: factor.revision,
            verifiedAt: f.dependencies.clock.now(),
          });
        }),
      ).toBe('REAUTHENTICATION_REQUIRED');
      expect((await assurance(f))?.expires_at).toEqual(original?.expires_at);
    });
  });
  test('tightening expires an old base immediately and later relaxation does not resurrect it', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { idleMinutes: 15 });
      await status(f);
      const original = await assurance(f);
      f.move(60_000);
      await policy(f, { idleMinutes: 60 });
      expect((await decision(f)).reason).toBe('assurance_changed');
      expect((await status(f)).state).toBe('allowed');
      expect((await assurance(f))?.expires_at).toEqual(original?.expires_at);
      f.move(5 * 60_000);
      await policy(f, { idleMinutes: 5 });
      expect((await status(f)).state).toBe('expired');
      await policy(f, { idleMinutes: 60 });
      expect((await status(f)).state).toBe('expired');
    });
  });
  test('an explicitly ended proof with remaining base life stays terminal even when policy is off', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f);
      await status(f);
      await db
        .updateTable('workspace_session_assurances')
        .set({ ended_at: f.dependencies.clock.now(), end_reason: 'factor_revoked' })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      await policy(f, { mode: 'off' });
      expect((await decision(f)).reason).toBe('assurance_ended');
      expect((await status(f)).state).toBe('expired');
    });
  });
  test('B/native activity and a readonly batch never refresh A workspace idle', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(f, { idleMinutes: 5 });
      await status(f);
      const a = await assurance(f);
      const w = await db
        .insertInto('workspaces')
        .values({ name: 'Other workspace', slug: aUniqueSlug('other-security') })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: w.id, user_id: f.actor.context.userId, role: 'owner' })
        .execute();
      const actor: WorkspaceSecurityActor = {
        context: await requireWorkspaceSecurityMembership(db, f.actor.context.userId, w.id),
        sessionId: f.actor.sessionId,
      };
      const b = { ...f, actor };
      await policy(b, { idleMinutes: 5 });
      f.move(3 * 60_000);
      await db
        .updateTable('sessions')
        .set({ last_used_at: f.dependencies.clock.now() })
        .where('id', '=', f.actor.sessionId)
        .execute();
      await status(b);
      f.move(3 * 60_000);
      const results = await readWorkspaceAccessDecisions(db, {
        ...readInput(f),
        workspaceIds: [f.actor.context.workspaceId, w.id],
      });
      expect(results.get(f.actor.context.workspaceId)?.allowed).toBe(false);
      expect(results.get(w.id)?.allowed).toBe(true);
      expect(await assurance(f)).toEqual(a);
    });
  });
  test('company scope validates exact evidence/source and never consults a global factor inventory', async () => {
    await withRollback(async (db) => {
      const base = await workspaceMfaFixture(db);
      const company = await companyWorkspaceMfaActor(base.dependencies, base.actor);
      const f = { ...base, actor: company.actor };
      await policy(f, {
        requireMfa: true,
        signIn: 'company',
        allowedConnectionIds: [company.connectionId],
      });
      await globalFactor(f);
      expect((await status(f)).state).toBe('mfa_enrollment_required');
      expect((await decision(f)).status.factorScope).toBeNull();
      await db
        .updateTable('workspace_identity_connections')
        .set({ enabled: false })
        .where('id', '=', company.connectionId)
        .execute();
      expect((await decision(f)).reason).toBe('source_invalid');
    });
  });
  test('server lifetime remains an upper bound even when workspace limits are relaxed', async () => {
    for (const lifetime of [
      { sessionIdleTimeoutHours: 1, sessionMaxAgeDays: null },
      { sessionIdleTimeoutHours: null, sessionMaxAgeDays: 1 },
    ] as const)
      await withRollback(async (db) => {
        const f = await workspaceMfaFixture(db);
        const dependencies: WorkspaceSecurityDependencies = {
          ...f.dependencies,
          lifetime: () => lifetime,
        };
        const bounded = { ...f, dependencies };
        await policy(bounded, { idleMinutes: null, maxAgeHours: null });
        await status(bounded);
        f.move(lifetime.sessionMaxAgeDays === null ? 60 * 60_000 : 24 * 60 * 60_000);
        expect((await decision(bounded)).reason).toBe('native_invalid');
      });
  });
});
