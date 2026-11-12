/** Company settings and own bindings use the existing API session/tenancy boundary and late service checks. */
import { Elysia, type AnyElysia } from 'elysia';
import { Value } from '@sinclair/typebox/value';
import { OlderPageQuery, Uuid } from '@purlay/types';
import {
  CompanyIdentityRevisionRequest,
  CompanySignInQuery,
  CreateCompanyConnectionRequest,
  CreateCompanyDomainRequest,
  SetCompanyConnectionEnabledRequest,
  UnlinkCompanyIdentityRequest,
  UpdateCompanyConnectionRequest,
} from '@purlay/types/workspace-identity';
import type { CredentialCipher } from '../../../platform/crypto';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import {
  identityMissing,
  type CompanyIdentityActor,
  type CompanyIdentityDependencies,
} from '../../../modules/workspaces/identity/authority';
import {
  createCompanyDomain,
  listCompanyDomains,
  lookupCompanyTxt,
  renewCompanyDomain,
  revokeCompanyDomain,
  verifyCompanyDomain,
} from '../../../modules/workspaces/identity/domains';
import {
  createCompanyConnection,
  deleteCompanyConnection,
  listCompanyConnections,
  setCompanyConnectionEnabled,
  updateCompanyConnection,
} from '../../../modules/workspaces/identity/connections';
import {
  myCompanyIdentities,
  unlinkCompanyIdentity,
} from '../../../modules/workspaces/identity/bindings';
import { companySignInOptions } from '../../../modules/workspaces/identity/catalogue';
import type { RouteContext } from '../route-context';
import { requireSession } from '../session';
import { queryOf, validated } from '../validate';

const identityId = (given: string): string => {
  if (!Value.Check(Uuid, given)) throw identityMissing();
  return given;
};

export const companyIdentityRoutes = (
  { dependencies }: RouteContext,
  cipher: CredentialCipher,
): AnyElysia => {
  const company: CompanyIdentityDependencies = {
    database: dependencies.database,
    clock: dependencies.clock,
    cipher,
    lifetime: () => dependencies.auth.sessionLifetime,
  };
  const actorOf = async (request: Request, workspaceId: string): Promise<CompanyIdentityActor> => {
    const session = await requireSession(dependencies.auth, request);
    const context = await requireWorkspaceMembership(
      dependencies.database,
      session.userId,
      workspaceId,
    );
    return { context, sessionId: session.sessionId };
  };
  return new Elysia()
    .get('/auth/company-options', async ({ request }) => {
      const input = validated(CompanySignInQuery, queryOf(new URL(request.url)));
      return await companySignInOptions(dependencies.database, input.workspace);
    })
    .get(
      '/api/workspaces/:workspaceId/identity/domains',
      async ({ request, params }) =>
        await listCompanyDomains(company, await actorOf(request, params.workspaceId)),
    )
    .post(
      '/api/workspaces/:workspaceId/identity/domains',
      async ({ request, params, body, set }) => {
        const actor = await actorOf(request, params.workspaceId);
        const input = validated(CreateCompanyDomainRequest, body);
        set.status = 201;
        return await createCompanyDomain(company, actor, input.domain);
      },
    )
    .post(
      '/api/workspaces/:workspaceId/identity/domains/:domainId/renew',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await renewCompanyDomain(
          company,
          actor,
          identityId(params.domainId),
          validated(CompanyIdentityRevisionRequest, body).revision,
        );
      },
    )
    .post(
      '/api/workspaces/:workspaceId/identity/domains/:domainId/verify',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await verifyCompanyDomain(
          company,
          actor,
          identityId(params.domainId),
          validated(CompanyIdentityRevisionRequest, body).revision,
          dependencies.companyTxtLookup ?? lookupCompanyTxt,
        );
      },
    )
    .delete(
      '/api/workspaces/:workspaceId/identity/domains/:domainId',
      async ({ request, params, body, set }) => {
        const actor = await actorOf(request, params.workspaceId);
        await revokeCompanyDomain(
          company,
          actor,
          identityId(params.domainId),
          validated(CompanyIdentityRevisionRequest, body).revision,
        );
        set.status = 204;
      },
    )
    .get(
      '/api/workspaces/:workspaceId/identity/connections',
      async ({ request, params }) =>
        await listCompanyConnections(company, await actorOf(request, params.workspaceId)),
    )
    .post(
      '/api/workspaces/:workspaceId/identity/connections',
      async ({ request, params, body, set }) => {
        const actor = await actorOf(request, params.workspaceId);
        const input = validated(CreateCompanyConnectionRequest, body);
        set.status = 201;
        return await createCompanyConnection(company, actor, input);
      },
    )
    .patch(
      '/api/workspaces/:workspaceId/identity/connections/:connectionId',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        return await updateCompanyConnection(
          company,
          actor,
          identityId(params.connectionId),
          validated(UpdateCompanyConnectionRequest, body),
        );
      },
    )
    .put(
      '/api/workspaces/:workspaceId/identity/connections/:connectionId/enabled',
      async ({ request, params, body }) => {
        const actor = await actorOf(request, params.workspaceId);
        const input = validated(SetCompanyConnectionEnabledRequest, body);
        return await setCompanyConnectionEnabled(
          company,
          actor,
          identityId(params.connectionId),
          input.revision,
          input.enabled,
        );
      },
    )
    .delete(
      '/api/workspaces/:workspaceId/identity/connections/:connectionId',
      async ({ request, params, body, set }) => {
        const actor = await actorOf(request, params.workspaceId);
        await deleteCompanyConnection(
          company,
          actor,
          identityId(params.connectionId),
          validated(CompanyIdentityRevisionRequest, body).revision,
        );
        set.status = 204;
      },
    )
    .get('/api/workspaces/:workspaceId/company-identities', async ({ request, params }) => {
      const actor = await actorOf(request, params.workspaceId);
      const query = validated(
        OlderPageQuery,
        queryOf(new URL(request.url), { numbers: ['limit'] }),
      );
      return await myCompanyIdentities(company, actor, query);
    })
    .delete(
      '/api/workspaces/:workspaceId/company-identities/:connectionId',
      async ({ request, params, body, set }) => {
        const actor = await actorOf(request, params.workspaceId);
        await unlinkCompanyIdentity(
          company,
          actor,
          identityId(params.connectionId),
          validated(UnlinkCompanyIdentityRequest, body).bindingId,
        );
        set.status = 204;
      },
    );
};
