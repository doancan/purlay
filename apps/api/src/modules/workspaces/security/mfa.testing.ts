/** Real core-only native rows for workspace remediation tests; no chat module or global MFA substitute. */
import type { Executor } from '@purlay/db';
import { credentialCipher } from '../../../platform/crypto';
import { AppError } from '../../../platform/errors';
import { requireWorkspaceSecurityMembership } from '../../../platform/tenancy';
import { randomToken, tokenDigest } from '../../../platform/tokens';
import { aMovableClock } from '../../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../../testing/users';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import { NO_SESSION_LIFETIME } from '../../auth/session-lifetime';
import type { WorkspaceSecurityActor, WorkspaceSecurityDependencies } from './authority';

export interface WorkspaceMfaFixture {
  readonly dependencies: WorkspaceSecurityDependencies;
  readonly actor: WorkspaceSecurityActor;
  readonly member: WorkspaceSecurityActor;
  readonly move: (milliseconds: number) => void;
}

export const workspaceMfaFixture = async (database: Executor): Promise<WorkspaceMfaFixture> => {
  const clock = aMovableClock(new Date('2026-11-12T03:00:00Z'));
  const workspace = await database
    .insertInto('workspaces')
    .values({ name: 'Workspace security', slug: aUniqueSlug('security') })
    .returning('id')
    .executeTakeFirstOrThrow();
  const actors: WorkspaceSecurityActor[] = [];
  for (const role of ['owner', 'member'] as const) {
    const user = await aUserRow(database, `security-${role}`);
    await database
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: user.userId, role })
      .execute();
    const session = await database
      .insertInto('sessions')
      .values({
        user_id: user.userId,
        token_hash: await tokenDigest(randomToken()),
        created_at: clock.now(),
        last_used_at: clock.now(),
        expires_at: new Date(clock.now().getTime() + 7 * 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordPrimaryAuthentication(database, session.id, user.userId, {
      method: 'password',
      authenticatedAt: clock.now(),
    });
    actors.push({
      context: await requireWorkspaceSecurityMembership(database, user.userId, workspace.id),
      sessionId: session.id,
    });
  }
  const actor = actors[0];
  const member = actors[1];
  if (actor === undefined || member === undefined)
    throw new Error('Missing security fixture actors');
  return {
    actor,
    member,
    move: clock.advance,
    dependencies: {
      database,
      clock,
      cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
      lifetime: () => NO_SESSION_LIFETIME,
    },
  };
};

/** Deliberate SQL fixture for service guards; native OAuth capture itself has its own real-provider roundtrip suite. */
export const companyWorkspaceMfaActor = async (
  dependencies: WorkspaceSecurityDependencies,
  source: WorkspaceSecurityActor,
): Promise<{ readonly actor: WorkspaceSecurityActor; readonly connectionId: string }> => {
  const database = dependencies.database;
  const workspace = source.context.workspaceId;
  const user = source.context.userId;
  const now = dependencies.clock.now();
  const domain = await database
    .insertInto('workspace_identity_domains')
    .values({
      workspace_id: workspace,
      domain: `${crypto.randomUUID()}.example.test`,
      challenge_issued_at: now,
      challenge_expires_at: new Date(now.getTime() + 86_400_000),
      verified_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const connectionId = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const issuer = `https://${connectionId}.example.test`;
  await database
    .insertInto('workspace_identity_connections')
    .values({
      id: connectionId,
      workspace_id: workspace,
      domain_id: domain.id,
      name: connectionId,
      issuer,
      client_id: 'service-fixture',
      client_secret_encrypted: Buffer.from(
        await dependencies.cipher.seal('fixture-provider-secret', connectionId),
      ),
      enabled: true,
      authentication_revision: revision,
      tested_authentication_revision: revision,
      tested_at: now,
    })
    .execute();
  const binding = await database
    .insertInto('workspace_identity_bindings')
    .values({
      workspace_id: workspace,
      user_id: user,
      connection_id: connectionId,
      issuer,
      subject: user,
      last_authenticated_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const session = await database
    .insertInto('sessions')
    .values({
      user_id: user,
      token_hash: await tokenDigest(randomToken()),
      company_workspace_id: workspace,
      created_at: now,
      last_used_at: now,
      expires_at: new Date(now.getTime() + 86_400_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database
    .insertInto('workspace_identity_sessions')
    .values({
      session_id: session.id,
      workspace_id: workspace,
      connection_id: connectionId,
      binding_reference: binding.id,
      authentication_revision: revision,
      authenticated_at: now,
    })
    .execute();
  await recordPrimaryAuthentication(database, session.id, user, {
    method: 'company_oidc',
    authenticatedAt: now,
    companyWorkspaceId: workspace,
    companyConnectionId: connectionId,
    companyAuthenticationRevision: revision,
  });
  return {
    actor: {
      context: await requireWorkspaceSecurityMembership(database, user, workspace),
      sessionId: session.id,
    },
    connectionId,
  };
};

/** AppError refusals do not roll back committed limiter writes inside the caller's rollback fixture. */
export const securityOutcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'taken';
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
};
