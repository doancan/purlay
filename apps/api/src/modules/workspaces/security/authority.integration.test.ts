/** Remediation capabilities recheck canonical authority without granting a workspace content context. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { requireWorkspaceSecurityMembership } from '../../../platform/tenancy';
import { aTransactionThatMustNotBeTouched } from '../../../testing/doubles';
import { copyAuthenticationEvidence } from '../../auth/authentication-evidence';
import { lockWorkspaceSecurityActor, requireFreshSecurityPrimary } from './authority';
import { companyWorkspaceMfaActor, securityOutcome, workspaceMfaFixture } from './mfa.testing';

afterAll(closeIntegrationDatabase);

describe('integration: workspace remediation authority', () => {
  test('rejects a copied capability before reaching SQL and rechecks the current role', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const forged = await lockWorkspaceSecurityActor(
        aTransactionThatMustNotBeTouched(),
        f.dependencies,
        { ...f.actor, context: { ...f.actor.context } },
        'self',
      ).catch((error: unknown) => error);
      expect(forged instanceof Error && forged.message).toContain('membership guard did not mint');
      expect(
        (await lockWorkspaceSecurityActor(db, f.dependencies, f.actor, 'owner')).context.role,
      ).toBe('owner');
      expect(
        await securityOutcome(
          async () =>
            await lockWorkspaceSecurityActor(db, f.dependencies, f.member, 'administrator'),
        ),
      ).toBe('FORBIDDEN');
      await db
        .updateTable('workspace_members')
        .set({ role: 'member' })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      expect(
        await securityOutcome(
          async () => await lockWorkspaceSecurityActor(db, f.dependencies, f.actor, 'owner'),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  test('native revocation, account admission and membership disappearance invalidate old capabilities', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await db
        .updateTable('users')
        .set({ suspended_at: f.dependencies.clock.now() })
        .where('id', '=', f.actor.context.userId)
        .execute();
      expect(
        await securityOutcome(
          async () => await lockWorkspaceSecurityActor(db, f.dependencies, f.actor, 'self'),
        ),
      ).toBe('UNAUTHENTICATED');
      await db
        .updateTable('users')
        .set({ suspended_at: null })
        .where('id', '=', f.actor.context.userId)
        .execute();
      await db
        .updateTable('sessions')
        .set({ expires_at: f.dependencies.clock.now() })
        .where('id', '=', f.actor.sessionId)
        .execute();
      expect(
        await securityOutcome(
          async () => await lockWorkspaceSecurityActor(db, f.dependencies, f.actor, 'self'),
        ),
      ).toBe('UNAUTHENTICATED');
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', f.member.context.workspaceId)
        .where('user_id', '=', f.member.context.userId)
        .execute();
      expect(
        await securityOutcome(
          async () => await lockWorkspaceSecurityActor(db, f.dependencies, f.member, 'self'),
        ),
      ).toBe('WORKSPACE_NOT_FOUND');
    });
  });

  test('guests keep only own remediation and cannot become workspace security administrators', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: f.dependencies.clock.now(),
          guest_modules: ['chat'],
          guest_expires_at: new Date('2027-01-01T00:00:00Z'),
        })
        .where('workspace_id', '=', f.member.context.workspaceId)
        .where('user_id', '=', f.member.context.userId)
        .execute();
      const locked = await lockWorkspaceSecurityActor(db, f.dependencies, f.member, 'self');
      expect(locked.context.guest?.kind).toBe('guest');
      requireFreshSecurityPrimary(f.dependencies, locked);
      expect(
        await securityOutcome(
          async () => await lockWorkspaceSecurityActor(db, f.dependencies, f.member, 'owner'),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  test('freshness uses the original authentication time across new native session IDs', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      f.move(299_999);
      requireFreshSecurityPrimary(
        f.dependencies,
        await lockWorkspaceSecurityActor(db, f.dependencies, f.actor, 'self'),
      );
      f.move(1);
      expect(
        await securityOutcome(async () => {
          requireFreshSecurityPrimary(
            f.dependencies,
            await lockWorkspaceSecurityActor(db, f.dependencies, f.actor, 'self'),
          );
        }),
      ).toBe('REAUTHENTICATION_REQUIRED');
      const target = await db
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
      await copyAuthenticationEvidence(db, f.actor.sessionId, target.id, f.actor.context.userId);
      expect(
        await securityOutcome(async () => {
          requireFreshSecurityPrimary(
            f.dependencies,
            await lockWorkspaceSecurityActor(
              db,
              f.dependencies,
              { ...f.actor, sessionId: target.id },
              'self',
            ),
          );
        }),
      ).toBe('REAUTHENTICATION_REQUIRED');
      await db
        .deleteFrom('session_authentication_evidence')
        .where('session_id', '=', f.member.sessionId)
        .execute();
      expect(
        await securityOutcome(async () => {
          requireFreshSecurityPrimary(
            f.dependencies,
            await lockWorkspaceSecurityActor(db, f.dependencies, f.member, 'self'),
          );
        }),
      ).toBe('REAUTHENTICATION_REQUIRED');
    });
  });

  test('company remediation stays in its live origin and never satisfies independent owner recovery', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const locked = await lockWorkspaceSecurityActor(db, f.dependencies, company.actor, 'self');
      requireFreshSecurityPrimary(f.dependencies, locked);
      expect(
        await securityOutcome(() => {
          requireFreshSecurityPrimary(f.dependencies, locked, { independent: true });
          return Promise.resolve();
        }),
      ).toBe('REAUTHENTICATION_REQUIRED');
      const other = await db
        .insertInto('workspaces')
        .values({ name: 'Unrelated', slug: crypto.randomUUID() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: other.id, user_id: f.actor.context.userId, role: 'owner' })
        .execute();
      const context = await requireWorkspaceSecurityMembership(
        db,
        f.actor.context.userId,
        other.id,
      );
      expect(
        await securityOutcome(
          async () =>
            await lockWorkspaceSecurityActor(
              db,
              f.dependencies,
              { context, sessionId: company.actor.sessionId },
              'self',
            ),
        ),
      ).toBe('WORKSPACE_NOT_FOUND');
      await db
        .deleteFrom('workspace_identity_connections')
        .where('id', '=', company.connectionId)
        .execute();
      expect(
        await securityOutcome(
          async () => await lockWorkspaceSecurityActor(db, f.dependencies, company.actor, 'self'),
        ),
      ).toBe('UNAUTHENTICATED');
      expect(
        (
          await db
            .selectFrom('sessions')
            .select('company_workspace_id')
            .where('id', '=', company.actor.sessionId)
            .executeTakeFirstOrThrow()
        ).company_workspace_id,
      ).toBe(f.actor.context.workspaceId);
    });
  });
});
