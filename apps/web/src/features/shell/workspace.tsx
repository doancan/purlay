/**
 * Which workspace the address names, if the person is in it.
 *
 * `/w/:slug` is a name in a URL, not a permission: the slug is looked up among the
 * person's own memberships, and one that is not there is the same *not found* as one
 * that never existed — the client does not distinguish them, because the API does not
 * (D-21: 404, never 403). Everything below this knows its workspace and the person's
 * role in it and does not ask again.
 */
import { createContext, useContext } from 'react';
import type { UserRole, Workspace } from '@purlay/types';
import { useSession } from '../session/session';

interface WorkspaceScope {
  readonly workspace: Workspace;
  readonly role: UserRole;
}

const WorkspaceContext = createContext<WorkspaceScope | null>(null);

export const useWorkspace = (): WorkspaceScope => {
  const scope = useContext(WorkspaceContext);
  if (scope === null) throw new Error('useWorkspace was called outside a WorkspaceScope');
  return scope;
};

export const WorkspaceScopeProvider = ({
  slug,
  notFound,
  children,
}: {
  readonly slug: string;
  /** Shown when the person has no workspace by that address. */
  readonly notFound: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { memberships } = useSession();
  const membership = memberships.find((m) => m.workspace.slug === slug);
  if (membership === undefined) return <>{notFound}</>;
  return (
    <WorkspaceContext.Provider value={{ workspace: membership.workspace, role: membership.role }}>
      {children}
    </WorkspaceContext.Provider>
  );
};
