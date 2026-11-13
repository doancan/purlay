/** Committed limiter errors and competing sessions use real independent native transactions. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { requireWorkspaceSecurityMembership } from '../../../platform/tenancy';
import { aWrongCode, codeAt, keyOf } from '../../../testing/totp';
import { copyAuthenticationEvidence } from '../../auth/authentication-evidence';
import { securityOutcome, workspaceMfaFixture } from './mfa.testing';
import { startWorkspaceMfaChallenge, startWorkspaceMfaEnrollment, verifyWorkspaceMfa } from './mfa';

let owned: ClonedDatabase | undefined;
beforeAll(async () => {
  owned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await owned?.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: committed workspace MFA proof consumption', () => {
  test('a production transaction commits wrong-attempt counters before returning the error', async () => {
    if (owned === undefined) throw new Error('Missing MFA test database');
    const f = await workspaceMfaFixture(owned.db);
    const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
      policyRevision: null,
      factorRevision: null,
    });
    const key = keyOf(setup.totpURI);
    await verifyWorkspaceMfa(f.dependencies, f.actor, {
      challengeId: setup.challenge.challengeId,
      code: codeAt(key, f.dependencies.clock.now().getTime()),
    });
    f.move(30_000);
    const challenge = await startWorkspaceMfaChallenge(f.dependencies, f.actor, {
      policyRevision: null,
      purpose: 'step_up',
      factorScope: 'workspace',
    });
    const wrong = aWrongCode(key, f.dependencies.clock.now().getTime());
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(
        await securityOutcome(
          async () =>
            await verifyWorkspaceMfa(f.dependencies, f.actor, {
              challengeId: challenge.challengeId,
              code: wrong,
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
    const factor = await owned.db
      .selectFrom('workspace_mfa_factors')
      .select('failed_verification_count')
      .where('id', '=', setup.factor.id)
      .executeTakeFirstOrThrow();
    expect(factor.failed_verification_count).toBe(5);
    const receipt = await owned.db
      .selectFrom('workspace_mfa_challenges')
      .select(['failed_attempts', 'consumed_at'])
      .where('factor_id', '=', setup.factor.id)
      .where('purpose', '=', 'step_up')
      .executeTakeFirstOrThrow();
    expect(receipt.failed_attempts).toBe(5);
    expect(receipt.consumed_at).not.toBeNull();
  });

  test('two real native sessions competing for the same timestep grant exactly one new proof', async () => {
    if (owned === undefined) throw new Error('Missing MFA test database');
    const f = await workspaceMfaFixture(owned.db);
    const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
      policyRevision: null,
      factorRevision: null,
    });
    const key = keyOf(setup.totpURI);
    await verifyWorkspaceMfa(f.dependencies, f.actor, {
      challengeId: setup.challenge.challengeId,
      code: codeAt(key, f.dependencies.clock.now().getTime()),
    });
    f.move(30_000);
    const second = await owned.db
      .insertInto('sessions')
      .values({
        user_id: f.actor.context.userId,
        token_hash: crypto.randomUUID(),
        created_at: f.dependencies.clock.now(),
        last_used_at: f.dependencies.clock.now(),
        expires_at: new Date(f.dependencies.clock.now().getTime() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await copyAuthenticationEvidence(
      owned.db,
      f.actor.sessionId,
      second.id,
      f.actor.context.userId,
    );
    const another = {
      context: await requireWorkspaceSecurityMembership(
        owned.db,
        f.actor.context.userId,
        f.actor.context.workspaceId,
      ),
      sessionId: second.id,
    };
    const firstChallenge = await startWorkspaceMfaChallenge(f.dependencies, f.actor, {
      policyRevision: null,
      purpose: 'step_up',
      factorScope: 'workspace',
    });
    const secondChallenge = await startWorkspaceMfaChallenge(f.dependencies, another, {
      policyRevision: null,
      purpose: 'step_up',
      factorScope: 'workspace',
    });
    const code = codeAt(key, f.dependencies.clock.now().getTime());
    expect(
      await securityOutcome(
        async () =>
          await verifyWorkspaceMfa(f.dependencies, f.actor, {
            challengeId: secondChallenge.challengeId,
            code,
          }),
      ),
    ).toBe('WORKSPACE_MFA_NOT_FOUND');
    const outcomes = await Promise.all([
      securityOutcome(
        async () =>
          await verifyWorkspaceMfa(f.dependencies, f.actor, {
            challengeId: firstChallenge.challengeId,
            code,
          }),
      ),
      securityOutcome(
        async () =>
          await verifyWorkspaceMfa(f.dependencies, another, {
            challengeId: secondChallenge.challengeId,
            code,
          }),
      ),
    ]);
    expect(outcomes.sort()).toEqual(['WORKSPACE_MFA_INVALID', 'taken']);
    expect(
      (
        await owned.db
          .selectFrom('workspace_mfa_factors')
          .select('last_accepted_counter')
          .where('id', '=', setup.factor.id)
          .executeTakeFirstOrThrow()
      ).last_accepted_counter,
    ).toBe(String(Math.floor(f.dependencies.clock.now().getTime() / 30_000)));
  });
});
