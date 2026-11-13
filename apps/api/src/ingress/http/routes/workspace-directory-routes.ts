/** Directory administrators configure native provisioning without granting global account authority. */
import { Elysia, type AnyElysia } from 'elysia';
import { Value } from '@sinclair/typebox/value';
import { OlderPageQuery, Uuid } from '@purlay/types';
import {
  CreateWorkspaceDirectoryRequest,
  DirectoryRevisionRequest,
  RevokeDirectoryCredentialRequest,
  RotateDirectoryCredentialRequest,
  UpdateWorkspaceDirectoryRequest,
} from '@purlay/types/workspace-directory';
import {
  directoryMissing,
  type WorkspaceDirectoryDependencies,
} from '../../../modules/workspaces/directory/authority';
import {
  createWorkspaceDirectory,
  deleteWorkspaceDirectory,
  listWorkspaceDirectories,
  revokeDirectoryCredential,
  rotateDirectoryCredential,
  updateWorkspaceDirectory,
} from '../../../modules/workspaces/directory/service';
import type { RouteContext } from '../route-context';
import { queryOf, validated } from '../validate';
import {
  workspaceProvisioningActor,
  workspaceProvisioningDependencies,
} from '../workspace-provisioning';

const directoryId = (given: string): string => {
  if (!Value.Check(Uuid, given)) throw directoryMissing();
  return given;
};

export const workspaceDirectoryRoutes = (context: RouteContext): AnyElysia => {
  const dependencies: WorkspaceDirectoryDependencies = {
    ...workspaceProvisioningDependencies(context),
    baseUrl: context.dependencies.config.APP_URL,
    bus: context.sockets.bus,
  };
  return new Elysia()
    .get(
      '/api/workspaces/:workspaceId/directories',
      async ({ request, params }) =>
        await listWorkspaceDirectories(
          dependencies,
          await workspaceProvisioningActor(context, request, params.workspaceId),
          validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] })),
        ),
    )
    .post('/api/workspaces/:workspaceId/directories', async ({ request, params, body, set }) => {
      const result = await createWorkspaceDirectory(
        dependencies,
        await workspaceProvisioningActor(context, request, params.workspaceId),
        validated(CreateWorkspaceDirectoryRequest, body),
      );
      set.status = 201;
      return result;
    })
    .patch(
      '/api/workspaces/:workspaceId/directories/:directoryId',
      async ({ request, params, body }) =>
        await updateWorkspaceDirectory(
          dependencies,
          await workspaceProvisioningActor(context, request, params.workspaceId),
          directoryId(params.directoryId),
          validated(UpdateWorkspaceDirectoryRequest, body),
        ),
    )
    .delete(
      '/api/workspaces/:workspaceId/directories/:directoryId',
      async ({ request, params, body, set }) => {
        await deleteWorkspaceDirectory(
          dependencies,
          await workspaceProvisioningActor(context, request, params.workspaceId),
          directoryId(params.directoryId),
          validated(DirectoryRevisionRequest, body).revision,
        );
        set.status = 204;
      },
    )
    .post(
      '/api/workspaces/:workspaceId/directories/:directoryId/credentials',
      async ({ request, params, body, set }) => {
        const result = await rotateDirectoryCredential(
          dependencies,
          await workspaceProvisioningActor(context, request, params.workspaceId),
          directoryId(params.directoryId),
          validated(RotateDirectoryCredentialRequest, body),
        );
        set.headers['cache-control'] = 'no-store';
        set.status = 201;
        return result;
      },
    )
    .post(
      '/api/workspaces/:workspaceId/directories/:directoryId/credentials/revoke',
      async ({ request, params, body }) =>
        await revokeDirectoryCredential(
          dependencies,
          await workspaceProvisioningActor(context, request, params.workspaceId),
          directoryId(params.directoryId),
          validated(RevokeDirectoryCredentialRequest, body),
        ),
    );
};
