/** Workspace guest administration: authenticate, validate, delegate scoped membership reads. */
import {
  ConvertGuestRequest,
  type WorkspaceMember,
  UpdateGuestAccessRequest,
  WorkspaceGuestQuery,
  type UpdatedGuestAccess,
  type WorkspaceGuestPage,
} from '@purlay/types';
import { listWorkspaceGuests } from '../../modules/workspaces/guests';
import { convertGuest } from '../../modules/workspaces/guest-conversion';
import { updateGuestAccess } from '../../modules/workspaces/guest-access';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireSession } from './session';
import { queryOf, validated } from './validate';
import type { MemberWriteDependencies, WorkspaceDependencies } from './workspaces';
import { atomicallyOn } from '../../platform/transactions';
import {
  NO_LOG,
  publication,
  publishAccessRevoked,
  publishAfterCommit,
  publishChannelsUpdated,
  publishWorkspaceUpdated,
} from '../../platform/events';

export const readWorkspaceGuests = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<WorkspaceGuestPage> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  const query = validated(
    WorkspaceGuestQuery,
    queryOf(new URL(request.url), { numbers: ['limit'] }),
  );
  return await listWorkspaceGuests(
    dependencies.database,
    context,
    query,
    dependencies.workspaceChannels,
  );
};

export const editWorkspaceGuest = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  workspaceId: string,
  userId: string,
  body: unknown,
): Promise<UpdatedGuestAccess> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const caller = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, caller.userId, workspaceId);
  const edit = validated(UpdateGuestAccessRequest, body);
  const changed = await atomicallyOn(database)(
    async (transaction) =>
      await updateGuestAccess(
        transaction,
        clock,
        context,
        userId,
        edit,
        dependencies.workspaceChannels,
        dependencies.guestAccessReady ?? false,
      ),
  );
  if (changed.changed)
    await publishAfterCommit(log, [
      [
        publication('ACCESS_REVOKED', () =>
          publishAccessRevoked(bus, clock, userId, changed.revokeChannelIds),
        ),
      ],
      [
        publication('CHANNELS_UPDATED', () =>
          publishChannelsUpdated(bus, clock, userId, workspaceId),
        ),
      ],
      [
        publication('WORKSPACE_UPDATED', () =>
          publishWorkspaceUpdated(bus, clock, changed.notifyUserIds, workspaceId),
        ),
      ],
    ]);
  return changed.guest;
};

/** A control hint only: reconnect always authenticates current authority again. */
export const convertWorkspaceGuest = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  workspaceId: string,
  userId: string,
  body: unknown,
): Promise<WorkspaceMember> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const caller = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, caller.userId, workspaceId);
  const input = validated(ConvertGuestRequest, body);
  const result = await atomicallyOn(database)(
    async (transaction) =>
      await convertGuest(
        transaction,
        clock,
        context,
        userId,
        input,
        dependencies.workspaceChannels,
      ),
  );
  if (result.changed)
    await publishAfterCommit(log, [
      [
        publication('WORKSPACE_UPDATED', () =>
          publishWorkspaceUpdated(bus, clock, [userId], workspaceId, true),
        ),
      ],
      [
        publication('CHANNELS_UPDATED', () =>
          publishChannelsUpdated(bus, clock, userId, workspaceId),
        ),
        publication('WORKSPACE_UPDATED', () =>
          publishWorkspaceUpdated(
            bus,
            clock,
            result.notifyUserIds.filter((id) => id !== userId),
            workspaceId,
          ),
        ),
      ],
    ]);
  return result.member;
};
