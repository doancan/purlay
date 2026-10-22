/**
 * This person's role in the workspace on screen, from the session's memberships — what decides which
 * settings pages they are offered (`sections.ts`). The server stays the authority on every change.
 */
import type { UserRole } from '@purlay/types';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';

export const useWorkspaceRole = (): UserRole | undefined => {
  const { memberships } = useSession();
  const { workspace } = useWorkspace();
  return memberships.find((membership) => membership.workspace.id === workspace.id)?.role;
};

/** Whether this person is the server's administrator, as the session says (`GET /api/me`): read only. */
export const useIsServerAdmin = (): boolean => useSession().isServerAdmin;
