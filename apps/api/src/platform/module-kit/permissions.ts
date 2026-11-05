/**
 * Who may do what, as names (`MODULES.md` §2). The core declares its own and each module its own in its manifest; the
 * table of a process is the core's and those of the modules it runs, so a module that is not run has no permission, and
 * a service that asks for one of its permissions is answered no, the owner included.
 *
 * Pure: it reads no environment and opens nothing.
 */
import type { UserRole } from '@purlay/types';
import type { PermissionDeclaration } from './manifest';

/** What the core's own services ask, by name. None yet: the core's role rules move here as their services are next changed (D-265). */
export const CORE_PERMISSIONS: readonly PermissionDeclaration[] = [];

const RANK: Readonly<Record<UserRole, number>> = { member: 0, admin: 1, owner: 2 };

export interface PermissionTable {
  /** Whether `role` holds the permission; one nobody declared is held by nobody. */
  readonly holds: (role: UserRole, name: string) => boolean;
}

export const permissionTable = (
  declarations: readonly PermissionDeclaration[],
): PermissionTable => {
  const minimum = new Map(declarations.map((declared) => [declared.name, declared.minimumRole]));
  return {
    holds: (role, name): boolean => {
      const lowest = minimum.get(name);
      return lowest !== undefined && RANK[role] >= RANK[lowest];
    },
  };
};
