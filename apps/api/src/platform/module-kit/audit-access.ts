/**
 * Which audit actions a role reads (D-222): each action belongs to a group that names the permission that reads it
 * (`AuditActionGroup`), and a role reads the trail's rows whose permission it holds. Rows are read whether or not the
 * module that wrote them runs: the trail is the workspace's record, so a module being off hides nothing from it unless
 * the permission that reads its rows is the module's own and so is no longer held.
 */
import type { UserRole } from '@purlay/types';
import { CORE_AUDIT_ACTIONS } from '@purlay/types';
import type { AuditActionGroup } from './manifest';
import type { PermissionTable } from './permissions';

/** The permission that reads the trail at all, and the one that reads what the core records. */
const READ_THE_TRAIL = 'audit.read';

export interface AuditAccess {
  /** Whether the role may open the trail, and download it. */
  readonly mayRead: (role: UserRole) => boolean;
  /** The actions the role is not shown: a row of one is not in a page, a count or a download. */
  readonly unreadable: (role: UserRole, delegatedAuditRead?: boolean) => readonly string[];
}

/** `groups` are those of every module the build carries, so a row of a module that is not run is still judged. */
export const auditAccess = (
  permissions: PermissionTable,
  groups: readonly AuditActionGroup[],
): AuditAccess => {
  const all: readonly AuditActionGroup[] = [
    { read: READ_THE_TRAIL, actions: CORE_AUDIT_ACTIONS },
    ...groups,
  ];
  return {
    mayRead: (role) => permissions.holds(role, READ_THE_TRAIL),
    unreadable: (role, delegatedAuditRead = false) =>
      all
        .filter(
          (group) =>
            !(delegatedAuditRead && group.read === READ_THE_TRAIL) &&
            !permissions.holds(role, group.read),
        )
        .flatMap((group) => group.actions),
  };
};
