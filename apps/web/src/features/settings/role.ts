/**
 * This person's role in the workspace on screen, from the session's memberships — what decides which
 * settings pages they are offered (`sections.ts`). The server stays the authority on every change.
 */
import type { UserRole, WorkspaceAccessAction, ChannelAccessAction } from '@purlay/types';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';

export const useWorkspaceRole = (): UserRole | undefined => {
  const { memberships } = useSession();
  const { workspace } = useWorkspace();
  return memberships.find((membership) => membership.workspace.id === workspace.id)?.role;
};

/** Whether this person is the server's administrator, as the session says (`GET /api/me`): read only. */
export const useIsServerAdmin = (): boolean => useSession().isServerAdmin;

/** Only the finite actions of this workspace's current membership are UI capabilities. */
export const useWorkspaceCapabilities = (): readonly WorkspaceAccessAction[] => {
  const { memberships } = useSession();
  const { workspace } = useWorkspace();
  return (
    memberships.find((membership) => membership.workspace.id === workspace.id)
      ?.workspaceCapabilities ?? []
  );
};

/** A navigation hint only: archived rows and restore authority remain exact server-side channel checks. */
export const useWorkspaceChannelCapabilities = (): readonly ChannelAccessAction[] => {
  const { memberships } = useSession();
  const { workspace, access } = useWorkspace();
  return access.kind === 'member'
    ? (memberships.find((membership) => membership.workspace.id === workspace.id)
        ?.channelCapabilities ?? [])
    : [];
};
