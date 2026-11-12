/** Company configuration cannot reuse stale cookies, restricted admission or copied tenancy capabilities. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback } from '@purlay/db';
import { companyIdentityFixture } from '../../../testing/company-identity';
import { attempt } from '../../../testing/attempt';
import { listCompanyDomains } from './domains';
import { lockCompanyIdentityActor } from './authority';
import type { SessionLifetime } from '../../auth/session-lifetime';
import { withinRequest } from '../../../platform/logging';
import { requireWorkspaceMembership } from '../../../platform/tenancy';

afterAll(closeIntegrationDatabase);

describe('integration: company identity actor authority', () => {
  test('a partial internal company scope without its source session fails closed in the canonical SQL guard', async () => {
    await withRollback(async (db) => {
      const { actor } = await companyIdentityFixture(db);
      const refused = await withinRequest(
        {
          requestId: 'company-source-missing',
          startedAt: performance.now(),
          companySession: { userId: actor.context.userId, workspaceId: actor.context.workspaceId },
        },
        async () =>
          await attempt(
            db,
            async () =>
              await requireWorkspaceMembership(db, actor.context.userId, actor.context.workspaceId),
          ),
      );
      expect(refused).toBe('WORKSPACE_NOT_FOUND');
    });
  });

  for (const change of [
    'expired',
    'revoked',
    'idle',
    'maximum-age',
    'suspended',
    'deleted',
    'pending',
    'unverified',
  ] as const) {
    test(`${change} accounts or sessions cannot manage company identity`, async () => {
      await withRollback(async (db) => {
        const { dependencies, actor } = await companyIdentityFixture(db);
        if (change === 'expired')
          await db
            .updateTable('sessions')
            .set({ expires_at: dependencies.clock.now() })
            .where('id', '=', actor.sessionId)
            .execute();
        if (change === 'revoked')
          await db
            .updateTable('sessions')
            .set({ revoked_at: dependencies.clock.now() })
            .where('id', '=', actor.sessionId)
            .execute();
        if (change === 'idle')
          await db
            .updateTable('sessions')
            .set({ last_used_at: new Date(dependencies.clock.now().getTime() - 3_600_000) })
            .where('id', '=', actor.sessionId)
            .execute();
        if (change === 'maximum-age')
          await db
            .updateTable('sessions')
            .set({ created_at: new Date(dependencies.clock.now().getTime() - 86_400_000) })
            .where('id', '=', actor.sessionId)
            .execute();
        if (change === 'suspended')
          await db
            .updateTable('users')
            .set({ suspended_at: dependencies.clock.now() })
            .where('id', '=', actor.context.userId)
            .execute();
        if (change === 'deleted')
          await db
            .updateTable('users')
            .set({ deleted_at: dependencies.clock.now() })
            .where('id', '=', actor.context.userId)
            .execute();
        if (change === 'pending')
          await db
            .updateTable('users')
            .set({ admission_state: 'pending' })
            .where('id', '=', actor.context.userId)
            .execute();
        if (change === 'unverified')
          await db
            .updateTable('users')
            .set({ admission_requires_verified_email: true, email_verified: false })
            .where('id', '=', actor.context.userId)
            .execute();
        const current = {
          ...dependencies,
          lifetime: (): SessionLifetime => ({
            sessionIdleTimeoutHours: change === 'idle' ? 1 : null,
            sessionMaxAgeDays: change === 'maximum-age' ? 1 : null,
          }),
        };
        expect(await attempt(db, async () => await listCompanyDomains(current, actor))).toBe(
          'UNAUTHENTICATED',
        );
      });
    });
  }

  test('a current guest cannot inherit an older administrator context', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', actor.context.userId)
        .execute();
      await db
        .updateTable('workspace_members')
        .set({
          role: 'member',
          access_kind: 'guest',
          guest_since: sql`statement_timestamp() - interval '1 second'`,
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', actor.context.workspaceId)
        .where('user_id', '=', actor.context.userId)
        .execute();
      expect(await attempt(db, async () => await listCompanyDomains(dependencies, actor))).toBe(
        'FORBIDDEN',
      );
      expect(
        await attempt(db, async () => {
          await lockCompanyIdentityActor(db, dependencies, actor, false);
        }),
      ).toBe('FORBIDDEN');
    });
  });

  test('copying a minted tenancy context does not mint a new capability', async () => {
    await withRollback(async (db) => {
      const { dependencies, actor } = await companyIdentityFixture(db);
      expect(
        await attempt(
          db,
          async () =>
            await listCompanyDomains(dependencies, { ...actor, context: { ...actor.context } }),
        ),
      ).toContain('membership guard did not mint');
    });
  });
});
