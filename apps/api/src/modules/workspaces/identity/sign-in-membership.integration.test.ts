/** Native sign-in proves membership for remediation without acquiring content authority. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { attempt } from '../../../testing/attempt';
import { companyIdentityFixture } from '../../../testing/company-identity';
import { assertMinted, assertSecurityMinted } from '../../../platform/tenancy';
import { lockCompanySignInMember } from './authority';

afterAll(closeIntegrationDatabase);

describe('integration: company sign-in membership capability', () => {
  test('a current member receives only a self-remediation capability', async () => {
    await withRollback(async (db) => {
      const { actor } = await companyIdentityFixture(db);
      const context = await lockCompanySignInMember(
        db,
        actor.context.workspaceId,
        actor.context.userId,
      );
      expect(context.userId).toBe(actor.context.userId);
      expect(context.workspaceId).toBe(actor.context.workspaceId);
      expect(() => {
        assertSecurityMinted(context);
      }).not.toThrow();
      expect(() => {
        Reflect.apply(assertMinted, undefined, [context]);
      }).toThrow('did not mint');
    });
  });

  test('a restricted guest cannot use the full-member company sign-in bootstrap', async () => {
    await withRollback(async (db) => {
      const { actor, dependencies } = await companyIdentityFixture(db);
      await db
        .updateTable('workspace_members')
        .set({
          role: 'member',
          access_kind: 'guest',
          guest_since: dependencies.clock.now(),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', actor.context.workspaceId)
        .where('user_id', '=', actor.context.userId)
        .execute();
      expect(
        await attempt(
          db,
          async () =>
            await lockCompanySignInMember(db, actor.context.workspaceId, actor.context.userId),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  for (const state of ['pending', 'suspended', 'deleted'] as const) {
    test(`${state} accounts cannot bootstrap company sign-in`, async () => {
      await withRollback(async (db) => {
        const { actor, dependencies } = await companyIdentityFixture(db);
        await db
          .updateTable('users')
          .set({
            ...(state === 'pending' ? { admission_state: 'pending' as const } : {}),
            ...(state === 'suspended' ? { suspended_at: dependencies.clock.now() } : {}),
            ...(state === 'deleted' ? { deleted_at: dependencies.clock.now() } : {}),
          })
          .where('id', '=', actor.context.userId)
          .execute();
        expect(
          await attempt(
            db,
            async () =>
              await lockCompanySignInMember(db, actor.context.workspaceId, actor.context.userId),
          ),
        ).toBe('UNAUTHENTICATED');
      });
    });
  }
});
