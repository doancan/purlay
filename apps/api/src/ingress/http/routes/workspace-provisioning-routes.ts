/** Workspace access routes validate contracts and delegate all source/projection authority. */
import { Elysia, type AnyElysia } from 'elysia';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import {
  AddManualWorkspaceAccessRequest,
  AssignWorkspaceAccessGrantRequest,
  ConfirmWorkspaceOffboardingRequest,
  CreateWorkspaceAccessGroupRequest,
  CreateWorkspaceAccessRoleRequest,
  PreviewWorkspaceOffboardingRequest,
  ProvisioningRevisionRequest,
  ReadmitWorkspaceMemberRequest,
  RevokeWorkspaceAccessSourceRequest,
  UpdateWorkspaceAccessGroupRequest,
  UpdateWorkspaceAccessRoleRequest,
  UpdateWorkspaceGroupMembersRequest,
  WorkspaceAccessGrantQuery,
  WorkspaceAccessGroupCandidateQuery,
  WorkspaceAccessListQuery,
  WorkspaceAccessPeopleQuery,
} from '@purlay/types/workspace-provisioning';
import type { AppError } from '../../../platform/errors';
import {
  addManualWorkspaceAccess,
  assignWorkspaceAccessGrant,
  createWorkspaceAccessGroup,
  createWorkspaceAccessRole,
  grantNotFound,
  listWorkspaceAccessGroupCandidates,
  listWorkspaceAccessGroupMembers,
  listWorkspaceAccessGroups,
  listWorkspaceAccessGrants,
  listWorkspaceAccessPeople,
  listWorkspaceAccessRoles,
  offboardWorkspaceMember,
  previewWorkspaceOffboarding,
  readmitWorkspaceMember,
  readWorkspaceMemberAccess,
  retireWorkspaceAccessGroup,
  retireWorkspaceAccessRole,
  revokeWorkspaceAccessGrant,
  revokeWorkspaceAccessSource,
  updateWorkspaceAccessGroup,
  updateWorkspaceAccessRole,
  updateWorkspaceAccessGroupMembers,
} from '../../../modules/workspaces/provisioning';
import {
  groupNotFound,
  roleNotFound,
  sourceNotFound,
  type WorkspaceProvisioningActor,
} from '../../../modules/workspaces/provisioning/authority';
import type { RouteContext } from '../route-context';
import { queryOf, validated } from '../validate';
import {
  workspaceProvisioningActor,
  workspaceProvisioningDependencies,
} from '../workspace-provisioning';

const resourceId = (id: string, missing: () => AppError): string => {
  if (!Value.Check(Uuid, id)) throw missing();
  return id;
};

export const workspaceProvisioningRoutes = (context: RouteContext): AnyElysia => {
  const dependencies = workspaceProvisioningDependencies(context);
  const actorOf = async (
    request: Request,
    workspaceId: string,
  ): Promise<WorkspaceProvisioningActor> =>
    await workspaceProvisioningActor(context, request, workspaceId);
  return new Elysia()
    .get(
      '/api/workspaces/:workspaceId/access/people',
      async ({ request, params }) =>
        await listWorkspaceAccessPeople(
          dependencies,
          await actorOf(request, params.workspaceId),
          validated(
            WorkspaceAccessPeopleQuery,
            queryOf(new URL(request.url), { numbers: ['limit'] }),
          ),
        ),
    )
    .get(
      '/api/workspaces/:workspaceId/access/people/:userId',
      async ({ request, params }) =>
        await readWorkspaceMemberAccess(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.userId, sourceNotFound),
        ),
    )
    .post(
      '/api/workspaces/:workspaceId/access/people/:userId/manual',
      async ({ request, params, body }) =>
        await addManualWorkspaceAccess(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.userId, sourceNotFound),
          validated(AddManualWorkspaceAccessRequest, body),
        ),
    )
    .post(
      '/api/workspaces/:workspaceId/access/people/:userId/sources/:sourceId/revoke',
      async ({ request, params, body }) =>
        await revokeWorkspaceAccessSource(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.userId, sourceNotFound),
          resourceId(params.sourceId, sourceNotFound),
          validated(RevokeWorkspaceAccessSourceRequest, body),
        ),
    )
    .post(
      '/api/workspaces/:workspaceId/access/people/:userId/offboarding/preview',
      async ({ request, params, body }) =>
        await previewWorkspaceOffboarding(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.userId, sourceNotFound),
          validated(PreviewWorkspaceOffboardingRequest, body),
        ),
    )
    .post(
      '/api/workspaces/:workspaceId/access/people/:userId/offboarding',
      async ({ request, params, body }) =>
        await offboardWorkspaceMember(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.userId, sourceNotFound),
          validated(ConfirmWorkspaceOffboardingRequest, body),
        ),
    )
    .post(
      '/api/workspaces/:workspaceId/access/people/:userId/readmission',
      async ({ request, params, body }) =>
        await readmitWorkspaceMember(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.userId, sourceNotFound),
          validated(ReadmitWorkspaceMemberRequest, body),
        ),
    )
    .get(
      '/api/workspaces/:workspaceId/access/roles',
      async ({ request, params }) =>
        await listWorkspaceAccessRoles(
          dependencies,
          await actorOf(request, params.workspaceId),
          validated(
            WorkspaceAccessListQuery,
            queryOf(new URL(request.url), { numbers: ['limit'] }),
          ),
        ),
    )
    .post('/api/workspaces/:workspaceId/access/roles', async ({ request, params, body, set }) => {
      const result = await createWorkspaceAccessRole(
        dependencies,
        await actorOf(request, params.workspaceId),
        validated(CreateWorkspaceAccessRoleRequest, body),
      );
      set.status = 201;
      return result;
    })
    .patch(
      '/api/workspaces/:workspaceId/access/roles/:roleId',
      async ({ request, params, body }) =>
        await updateWorkspaceAccessRole(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.roleId, roleNotFound),
          validated(UpdateWorkspaceAccessRoleRequest, body),
        ),
    )
    .delete(
      '/api/workspaces/:workspaceId/access/roles/:roleId',
      async ({ request, params, body, set }) => {
        await retireWorkspaceAccessRole(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.roleId, roleNotFound),
          validated(ProvisioningRevisionRequest, body),
        );
        set.status = 204;
      },
    )
    .get(
      '/api/workspaces/:workspaceId/access/groups',
      async ({ request, params }) =>
        await listWorkspaceAccessGroups(
          dependencies,
          await actorOf(request, params.workspaceId),
          validated(
            WorkspaceAccessListQuery,
            queryOf(new URL(request.url), { numbers: ['limit'] }),
          ),
        ),
    )
    .post('/api/workspaces/:workspaceId/access/groups', async ({ request, params, body, set }) => {
      const result = await createWorkspaceAccessGroup(
        dependencies,
        await actorOf(request, params.workspaceId),
        validated(CreateWorkspaceAccessGroupRequest, body),
      );
      set.status = 201;
      return result;
    })
    .patch(
      '/api/workspaces/:workspaceId/access/groups/:groupId',
      async ({ request, params, body }) =>
        await updateWorkspaceAccessGroup(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.groupId, groupNotFound),
          validated(UpdateWorkspaceAccessGroupRequest, body),
        ),
    )
    .delete(
      '/api/workspaces/:workspaceId/access/groups/:groupId',
      async ({ request, params, body, set }) => {
        await retireWorkspaceAccessGroup(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.groupId, groupNotFound),
          validated(ProvisioningRevisionRequest, body),
        );
        set.status = 204;
      },
    )
    .get(
      '/api/workspaces/:workspaceId/access/groups/:groupId/members',
      async ({ request, params }) =>
        await listWorkspaceAccessGroupMembers(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.groupId, groupNotFound),
          validated(
            WorkspaceAccessListQuery,
            queryOf(new URL(request.url), { numbers: ['limit'] }),
          ),
        ),
    )
    .patch(
      '/api/workspaces/:workspaceId/access/groups/:groupId/members',
      async ({ request, params, body }) =>
        await updateWorkspaceAccessGroupMembers(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.groupId, groupNotFound),
          validated(UpdateWorkspaceGroupMembersRequest, body),
        ),
    )
    .get(
      '/api/workspaces/:workspaceId/access/groups/:groupId/candidates',
      async ({ request, params }) =>
        await listWorkspaceAccessGroupCandidates(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.groupId, groupNotFound),
          validated(
            WorkspaceAccessGroupCandidateQuery,
            queryOf(new URL(request.url), { numbers: ['limit'] }),
          ),
        ),
    )
    .get(
      '/api/workspaces/:workspaceId/access/grants',
      async ({ request, params }) =>
        await listWorkspaceAccessGrants(
          dependencies,
          await actorOf(request, params.workspaceId),
          validated(
            WorkspaceAccessGrantQuery,
            queryOf(new URL(request.url), { numbers: ['limit'] }),
          ),
        ),
    )
    .post('/api/workspaces/:workspaceId/access/grants', async ({ request, params, body, set }) => {
      const result = await assignWorkspaceAccessGrant(
        dependencies,
        await actorOf(request, params.workspaceId),
        validated(AssignWorkspaceAccessGrantRequest, body),
      );
      set.status = 201;
      return result;
    })
    .delete(
      '/api/workspaces/:workspaceId/access/grants/:grantId',
      async ({ request, params, body, set }) => {
        await revokeWorkspaceAccessGrant(
          dependencies,
          await actorOf(request, params.workspaceId),
          resourceId(params.grantId, grantNotFound),
          validated(ProvisioningRevisionRequest, body),
        );
        set.status = 204;
      },
    );
};
