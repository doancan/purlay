/** Remediation has membership authority only; the ordinary content guard remains closed until verification succeeds. */
import { Elysia, type AnyElysia } from 'elysia';
import {
  ChangeWorkspaceMfaRequest,
  CreateWorkspacePolicyRecoveryRequest,
  PreviewWorkspacePolicyRequest,
  RecoverWorkspacePolicyRequest,
  StartWorkspaceMfaChallengeRequest,
  StartWorkspaceMfaEnrollmentRequest,
  TestWorkspacePolicyRequest,
  UpdateWorkspacePolicyRequest,
  UseWorkspaceMfaRecoveryRequest,
  VerifyWorkspaceMfaRequest,
  WorkspaceSecurityLookupQuery,
  type WorkspaceSecurityEntry,
} from '@purlay/types/workspace-security';
import type { CredentialCipher } from '../../../platform/crypto';
import { requireWorkspaceSecurityMembership, workspaceNotFound } from '../../../platform/tenancy';
import { workspacePolicyReadersReady } from '../../../platform/workspace-policy-readiness';
import { workspaceAccessStatus } from '../../../modules/workspaces/security/access';
import type { WorkspaceSecurityActor } from '../../../modules/workspaces/security/authority';
import {
  myWorkspaceMfa,
  revokeWorkspaceMfa,
  rotateWorkspaceMfaRecoveryCodes,
  startWorkspaceMfaChallenge,
  startWorkspaceMfaEnrollment,
  useWorkspaceMfaRecovery,
  verifyWorkspaceMfa,
} from '../../../modules/workspaces/security/mfa';
import {
  createWorkspacePolicyRecovery,
  previewWorkspacePolicy,
  readWorkspacePolicy,
  recoverWorkspacePolicy,
  testWorkspacePolicy,
  updateWorkspacePolicy,
  type WorkspacePolicyDependencies,
} from '../../../modules/workspaces/security/policy';
import { authMethods } from '../auth-methods';
import type { RouteContext } from '../route-context';
import { requireSession } from '../session';
import { queryOf, validated } from '../validate';

export const workspaceSecurityRoutes = (
  { dependencies }: RouteContext,
  cipher: CredentialCipher,
): AnyElysia => {
  const security: WorkspacePolicyDependencies = {
    database: dependencies.database,
    clock: dependencies.clock,
    cipher,
    lifetime: () => dependencies.auth.sessionLifetime,
    signInMethods: () => authMethods(dependencies.auth),
    policyReadersReady: async () =>
      await workspacePolicyReadersReady({
        attested: dependencies.config.WORKSPACE_ACCESS_READY,
        redisConfigured: dependencies.config.REDIS_URL !== undefined,
        ...(dependencies.workspaceAccessPeersBehind === undefined
          ? {}
          : { peersBehind: dependencies.workspaceAccessPeersBehind }),
      }),
  };
  const actorOf = async (
    request: Request,
    workspaceId: string,
  ): Promise<WorkspaceSecurityActor> => {
    const session = await requireSession(dependencies.auth, request);
    const context = await requireWorkspaceSecurityMembership(
      dependencies.database,
      session.userId,
      workspaceId,
    );
    return { context, sessionId: session.sessionId };
  };
  return new Elysia()
    .get('/api/workspace-security', async ({ request }): Promise<WorkspaceSecurityEntry> => {
      const session = await requireSession(dependencies.auth, request);
      const input = validated(WorkspaceSecurityLookupQuery, queryOf(new URL(request.url)));
      const row = await dependencies.database
        .selectFrom('workspaces')
        .select(['id', 'name', 'slug'])
        .where('slug', '=', input.workspace)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (row === undefined) throw workspaceNotFound();
      const context = await requireWorkspaceSecurityMembership(
        dependencies.database,
        session.userId,
        row.id,
      );
      const status = await workspaceAccessStatus(security, {
        context,
        sessionId: session.sessionId,
      });
      return {
        workspaceId: context.workspaceId,
        slug: row.slug,
        name: row.name,
        role: context.role,
        accessKind: context.guest === undefined ? 'member' : 'guest',
        status,
      };
    })
    .get(
      '/api/workspaces/:workspaceId/security/access',
      async ({ request, params }) =>
        await workspaceAccessStatus(security, await actorOf(request, params.workspaceId)),
    )
    .get(
      '/api/workspaces/:workspaceId/security/policy',
      async ({ request, params }) =>
        await readWorkspacePolicy(security, await actorOf(request, params.workspaceId)),
    )
    .post(
      '/api/workspaces/:workspaceId/security/policy/preview',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await previewWorkspacePolicy(
          security,
          actor,
          validated(PreviewWorkspacePolicyRequest, body),
        );
      },
    )
    .post(
      '/api/workspaces/:workspaceId/security/policy/test',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await testWorkspacePolicy(
          security,
          actor,
          validated(TestWorkspacePolicyRequest, body),
        );
      },
    )
    .put('/api/workspaces/:workspaceId/security/policy', async ({ request, params, body }) => {
      const actor = await actorOf(request, params.workspaceId);
      return await updateWorkspacePolicy(
        security,
        actor,
        validated(UpdateWorkspacePolicyRequest, body),
      );
    })
    .post('/api/workspaces/:workspaceId/security/recovery', async ({ request, params, body }) => {
      const actor = await actorOf(request, params.workspaceId);
      return await createWorkspacePolicyRecovery(
        security,
        actor,
        validated(CreateWorkspacePolicyRecoveryRequest, body),
      );
    })
    .post('/api/workspaces/:workspaceId/security/recover', async ({ request, params, body }) => {
      const actor = await actorOf(request, params.workspaceId);
      return await recoverWorkspacePolicy(
        security,
        actor,
        validated(RecoverWorkspacePolicyRequest, body),
      );
    })
    .get(
      '/api/workspaces/:workspaceId/security/mfa',
      async ({ request, params }) =>
        await myWorkspaceMfa(security, await actorOf(request, params.workspaceId)),
    )
    .post(
      '/api/workspaces/:workspaceId/security/mfa/enrollment',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await startWorkspaceMfaEnrollment(
          security,
          actor,
          validated(StartWorkspaceMfaEnrollmentRequest, body),
        );
      },
    )
    .post(
      '/api/workspaces/:workspaceId/security/mfa/challenges',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await startWorkspaceMfaChallenge(
          security,
          actor,
          validated(StartWorkspaceMfaChallengeRequest, body),
        );
      },
    )
    .post('/api/workspaces/:workspaceId/security/mfa/verify', async ({ request, params, body }) => {
      const actor = await actorOf(request, params.workspaceId);
      return await verifyWorkspaceMfa(security, actor, validated(VerifyWorkspaceMfaRequest, body));
    })
    .post(
      '/api/workspaces/:workspaceId/security/mfa/recovery',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await useWorkspaceMfaRecovery(
          security,
          actor,
          validated(UseWorkspaceMfaRecoveryRequest, body),
        );
      },
    )
    .delete('/api/workspaces/:workspaceId/security/mfa', async ({ request, params, body }) => {
      const actor = await actorOf(request, params.workspaceId);
      return await revokeWorkspaceMfa(security, actor, validated(ChangeWorkspaceMfaRequest, body));
    })
    .post(
      '/api/workspaces/:workspaceId/security/mfa/recovery-codes',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await rotateWorkspaceMfaRecoveryCodes(
          security,
          actor,
          validated(ChangeWorkspaceMfaRequest, body),
        );
      },
    );
};
