/**
 * `PATCH /api/me/profile` (#488, D-131): the caller's own title, time zone and status line. A change
 * tells everyone in each workspace the caller is in, after the commit, to read the members again —
 * the same `WORKSPACE_UPDATED` a rename sends (D-124), which carries nothing but the workspace.
 */
import { UpdateProfileRequest, type Profile } from '@purlay/types';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishWorkspaceUpdated,
} from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { updateProfile } from '../../modules/users/profile';
import { requireSession } from './session';
import { validated } from './validate';
import type { MemberWriteDependencies } from './workspaces';

export const updateMyProfile = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  body: unknown,
): Promise<Profile> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const input = validated(UpdateProfileRequest, body);
  const change = await atomicallyOn(database)(
    async (transaction) => await updateProfile(transaction, userId, input),
  );
  await publishAfterCommit(
    log,
    change.told.map(({ workspaceId, memberIds }) => [
      publication('WORKSPACE_UPDATED', () =>
        publishWorkspaceUpdated(bus, clock, memberIds, workspaceId),
      ),
    ]),
  );
  return change.profile;
};
