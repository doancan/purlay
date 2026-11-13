/** Core-only native fixtures for policy services; independent availability is real account state. */
import type { Executor } from '@purlay/db';
import type { WorkspacePolicySettings } from '@purlay/types/workspace-security';
import { requireWorkspaceSecurityMembership } from '../../../platform/tenancy';
import { randomToken, tokenDigest } from '../../../platform/tokens';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import { workspaceMfaFixture, type WorkspaceMfaFixture } from './mfa.testing';
import type { WorkspaceSecurityActor } from './authority';
import type { WorkspacePolicyDependencies } from './policy-authority';
import { defaultWorkspacePolicy } from './policy-state';

export interface WorkspacePolicyFixture extends WorkspaceMfaFixture {
  readonly dependencies: WorkspacePolicyDependencies;
}
export const workspacePolicyFixture = async (
  database: Executor,
): Promise<WorkspacePolicyFixture> => {
  const fixture = await workspaceMfaFixture(database);
  for (const actor of [fixture.actor, fixture.member])
    await database
      .insertInto('accounts')
      .values({
        user_id: actor.context.userId,
        account_id: actor.context.userId,
        provider_id: 'credential',
        password: 'policy-fixture-only-hash',
      })
      .execute();
  return {
    ...fixture,
    dependencies: {
      ...fixture.dependencies,
      signInMethods: () => ({
        password: true,
        email: true,
        github: false,
        google: false,
        oidc: null,
        signUp: 'invite-only',
      }),
      policyReadersReady: () => Promise.resolve(true),
    },
  };
};

export const freshPolicyActor = async (
  fixture: WorkspacePolicyFixture,
  actor = fixture.actor,
): Promise<WorkspaceSecurityActor> => {
  const database = fixture.dependencies.database;
  const now = fixture.dependencies.clock.now();
  const session = await database
    .insertInto('sessions')
    .values({
      user_id: actor.context.userId,
      token_hash: await tokenDigest(randomToken()),
      created_at: now,
      last_used_at: now,
      expires_at: new Date(now.getTime() + 86_400_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await recordPrimaryAuthentication(database, session.id, actor.context.userId, {
    method: 'password',
    authenticatedAt: now,
  });
  return {
    sessionId: session.id,
    context: await requireWorkspaceSecurityMembership(
      database,
      actor.context.userId,
      actor.context.workspaceId,
    ),
  };
};
export const enforcedPolicy = (
  changes: Partial<WorkspacePolicySettings> = {},
): WorkspacePolicySettings => ({
  ...defaultWorkspacePolicy(),
  mode: 'enforced',
  maxAgeHours: 1,
  ...changes,
});
