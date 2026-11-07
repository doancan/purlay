/** Personal headings and channel placement; changes are announced only to their owner's topic. */
import { Elysia, type AnyElysia } from 'elysia';
import {
  FoldChannelGroupRequest,
  MoveChannelGroupRequest,
  ChannelGroupQuery,
  SaveChannelGroupRequest,
  type Channel,
  type ChannelGroup,
  type ChannelGroupPage,
} from '@purlay/types';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelsUpdated,
} from '../../../platform/events';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import { requireChannelById } from '../channels/guard';
import { channelFor } from '../channels/channels';
import { foldGroup, listGroups, moveToGroup, removeGroup, saveGroup } from '../channels/groups';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';

const inWorkspace = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<WorkspaceContext> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
};

const told = async (
  dependencies: ChannelWriteDependencies,
  context: { readonly userId: string; readonly workspaceId: string },
  changed: boolean,
): Promise<void> => {
  if (!changed) return;
  await publishAfterCommit(dependencies.log ?? NO_LOG, [
    [
      publication('CHANNELS_UPDATED', () =>
        publishChannelsUpdated(
          dependencies.bus,
          dependencies.clock,
          context.userId,
          context.workspaceId,
        ),
      ),
    ],
  ]);
};

const groups = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<ChannelGroupPage> => {
  const context = await inWorkspace(dependencies, request, workspaceId);
  const query = validated(ChannelGroupQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await listGroups(dependencies.database, context, query);
};

const putGroup = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  workspaceId: string,
  groupId: string,
  body: unknown,
): Promise<ChannelGroup> => {
  const context = await inWorkspace(dependencies, request, workspaceId);
  const input = validated(SaveChannelGroupRequest, body);
  const result = await atomicallyOn(dependencies.database)(
    async (transaction) => await saveGroup(transaction, context, groupId, input.name),
  );
  await told(dependencies, context, result.changed);
  return result.group;
};

const patchGroup = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  workspaceId: string,
  groupId: string,
  body: unknown,
): Promise<ChannelGroup> => {
  const context = await inWorkspace(dependencies, request, workspaceId);
  const input = validated(FoldChannelGroupRequest, body);
  const result = await atomicallyOn(dependencies.database)(
    async (transaction) => await foldGroup(transaction, context, groupId, input.collapsed),
  );
  await told(dependencies, context, result.changed);
  return result.group;
};

const deleteGroup = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  workspaceId: string,
  groupId: string,
): Promise<void> => {
  const context = await inWorkspace(dependencies, request, workspaceId);
  const changed = await atomicallyOn(dependencies.database)(
    async (transaction) => await removeGroup(transaction, context, groupId),
  );
  await told(dependencies, context, changed);
};

const putPlacement = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<Channel> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(dependencies.database, userId, channelId);
  const input = validated(MoveChannelGroupRequest, body);
  const result = await atomicallyOn(dependencies.database)(async (transaction) => {
    const changed = await moveToGroup(transaction, context, input.groupId);
    return { changed, channel: await channelFor(transaction, userId, channelId) };
  });
  await told(dependencies, context, result.changed);
  return result.channel;
};

export const channelGroupRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/channel-groups',
      async ({ request, params }) => await groups(context, request, params.workspaceId),
    )
    .put(
      '/api/workspaces/:workspaceId/channel-groups/:groupId',
      async ({ request, params, body }) =>
        await putGroup(context, request, params.workspaceId, params.groupId, body),
    )
    .patch(
      '/api/workspaces/:workspaceId/channel-groups/:groupId',
      async ({ request, params, body }) =>
        await patchGroup(context, request, params.workspaceId, params.groupId, body),
    )
    .delete(
      '/api/workspaces/:workspaceId/channel-groups/:groupId',
      async ({ request, params, set }) => {
        await deleteGroup(context, request, params.workspaceId, params.groupId);
        set.status = 204;
        return null;
      },
    )
    .put(
      '/api/channels/:channelId/sidebar-group',
      async ({ request, params, body }) =>
        await putPlacement(context, request, params.channelId, body),
    );
