/** Native workspace access administration; this facade exposes the actual scoped service contracts. */
export { listWorkspaceAccessPeople, readWorkspaceMemberAccess } from './read-access';
export {
  createWorkspaceAccessRole,
  listWorkspaceAccessRoles,
  updateWorkspaceAccessRole,
  retireWorkspaceAccessRole,
} from './roles';
export {
  createWorkspaceAccessGroup,
  listWorkspaceAccessGroups,
  updateWorkspaceAccessGroup,
  retireWorkspaceAccessGroup,
} from './groups';
export {
  listWorkspaceAccessGroupCandidates,
  listWorkspaceAccessGroupMembers,
  updateWorkspaceAccessGroupMembers,
} from './group-members';
export {
  assignWorkspaceAccessGrant,
  grantNotFound,
  listWorkspaceAccessGrants,
  revokeWorkspaceAccessGrant,
} from './grants';
export {
  addManualWorkspaceAccess,
  offboardWorkspaceMember,
  previewWorkspaceOffboarding,
  readmitWorkspaceMember,
  revokeWorkspaceAccessSource,
} from './source-offboarding';
