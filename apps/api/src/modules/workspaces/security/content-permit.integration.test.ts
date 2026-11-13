/** A batch decision alone cannot create authority in another source or after the injected clock expires. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { aSession } from '../../../testing/signed-in';
import { aMovableClock } from '../../../testing/doubles';
import { withinRequest } from '../../../platform/logging';
import { readWorkspaceContentPermits } from '../../../platform/workspace-content-fence';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import { workspaceAccessStatus } from './access';
import { workspaceMfaFixture } from './mfa.testing';

afterAll(closeIntegrationDatabase);
describe('integration: captured workspace permits', () => {
  test('only the exact native source can capture real SQL facts; fresh clock expiration defeats an old allowed decision', async () => {
    await withRollback(async (db) => {
      const old = await workspaceMfaFixture(db);
      const clock = aMovableClock(new Date());
      const userId = old.actor.context.userId;
      const workspaceId = old.actor.context.workspaceId;
      const session = await aSession(db, clock, userId);
      await recordPrimaryAuthentication(db, session.sessionId, userId, {
        method: 'password',
        authenticatedAt: clock.now(),
      });
      const dependencies = { ...old.dependencies, clock };
      const actor = { ...old.actor, sessionId: session.sessionId };
      // A requested native permit keeps its owner even when workspace enforcement is off.
      const off = (
        await readWorkspaceContentPermits(db, {
          workspaceId,
          sessionIds: [session.sessionId],
          now: clock.now(),
          lifetime: dependencies.lifetime(),
        })
      ).get(session.sessionId);
      if (off === undefined) throw new Error('Missing native off-policy permit');
      expect(off.decision.allowed).toBe(true);
      await withinRequest(
        { requestId: 'foreign-off-native', startedAt: 0, sessionId: crypto.randomUUID() },
        () => {
          expect(() => {
            off.capture(clock.now());
          }).toThrow('Verify workspace access');
          return Promise.resolve();
        },
      );
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', workspaceId)
        .execute();
      await db
        .insertInto('workspace_access_policies')
        .values({
          workspace_id: workspaceId,
          epoch: '1',
          mode: 'enforced',
          sign_in: 'any',
          require_mfa: false,
          idle_minutes: 15,
          max_age_hours: 1,
          mfa_max_age_minutes: 5,
        })
        .execute();
      expect((await workspaceAccessStatus(dependencies, actor)).state).toBe('allowed');
      const factor = await db
        .insertInto('workspace_mfa_factors')
        .values({
          workspace_id: workspaceId,
          user_id: userId,
          secret_encrypted: Buffer.from('sealed permit fixture'),
          state: 'verified',
          verified_at: clock.now(),
        })
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow();
      await db
        .updateTable('workspace_session_assurances')
        .set({
          factor_scope: 'workspace',
          factor_id: factor.id,
          factor_revision: factor.revision,
          mfa_verified_at: clock.now(),
          mfa_expires_at: new Date(clock.now().getTime() + 5_000),
        })
        .where('workspace_id', '=', workspaceId)
        .where('session_id', '=', session.sessionId)
        .execute();
      await db
        .updateTable('workspace_access_policies')
        .set({ require_mfa: true })
        .where('workspace_id', '=', workspaceId)
        .execute();
      const permits = await readWorkspaceContentPermits(db, {
        workspaceId,
        sessionIds: [session.sessionId],
        now: clock.now(),
        lifetime: dependencies.lifetime(),
      });
      const permit = permits.get(session.sessionId);
      if (permit === undefined) throw new Error('Missing canonical permit');
      expect(permit.decision.allowed).toBe(true);
      await withinRequest(
        { requestId: 'foreign-permit', startedAt: 0, sessionId: crypto.randomUUID() },
        () => {
          expect(() => {
            permit.capture(clock.now());
          }).toThrow('Verify workspace access');
          return Promise.resolve();
        },
      );
      const scope = { requestId: 'exact-permit', startedAt: 0, sessionId: session.sessionId };
      await withinRequest(scope, () => {
        permit.capture(clock.now());
        return Promise.resolve();
      });
      clock.advance(5_001);
      await withinRequest(scope, () => {
        expect(() => {
          permit.capture(clock.now());
        }).toThrow('Verify workspace access');
        return Promise.resolve();
      });
      expect(permit.decision.allowed).toBe(true);
    });
  });
});
